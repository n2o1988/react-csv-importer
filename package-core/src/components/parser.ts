import Papa from 'papaparse';

import { BaseRow } from '../exports';

export interface PreviewInfo {
  file: File;
  firstChunk: string;
  firstRows: string[][]; // always PREVIEW_ROWS count
  hasHeaders: boolean;
}

export type PreviewResults =
  | ({
      parseError: undefined;
      parseWarning?: Papa.ParseError;
    } & PreviewInfo)
  | {
      parseError: Error | Papa.ParseError;
    };

export const PREVIEW_ROW_COUNT = 5;

export type FieldAssignmentMap = { [name: string]: number | undefined };

export function parsePreview(file: File): Promise<PreviewResults> {
  // wrap synchronous errors in promise
  return new Promise<PreviewResults>((resolve) => {
    let firstChunk: string | null = null;
    let firstWarning: Papa.ParseError | undefined = undefined;
    const rowAccumulator: string[][] = [];

    function reportSuccess() {
      while (rowAccumulator.length < PREVIEW_ROW_COUNT) {
        rowAccumulator.push([]);
      }

      resolve({
        file,
        parseError: undefined,
        parseWarning: firstWarning || undefined,
        firstChunk: firstChunk || '',
        firstRows: rowAccumulator,
        hasHeaders: false // placeholder to modify downstream
      });
    }

    // @todo true streaming support for local files (use worker?)
    Papa.parse(file, {
      chunkSize: 20000,
      preview: PREVIEW_ROW_COUNT,
      skipEmptyLines: true,
      error: (error) => {
        resolve({
          parseError: error
        });
      },
      beforeFirstChunk: (chunk) => {
        firstChunk = chunk;
      },
      chunk: ({ data, errors }, parser) => {
        data.forEach((row) => {
          rowAccumulator.push(
            (row as unknown[]).map((item) =>
              typeof item === 'string' ? item : ''
            )
          );
        });

        if (errors.length > 0 && !firstWarning) {
          firstWarning = errors[0];
        }

        // finish parsing after first chunk
        if (rowAccumulator.length < PREVIEW_ROW_COUNT) {
          parser.abort();
        }

        reportSuccess();
      },
      complete: reportSuccess
    });
  }).catch(() => {
    return {
      parseError: new Error('Internal error while generating preview')
    };
  });
}

export function processFile<Row extends BaseRow>(
  file: File,
  hasHeaders: boolean,
  fieldAssignments: FieldAssignmentMap,
  reportProgress: (deltaCount: number) => void,
  callback: (rows: Row[]) => void | Promise<void>
): Promise<void> {
  const fieldNames = Object.keys(fieldAssignments);

  // wrap synchronous errors in promise
  return new Promise<void>((resolve, reject) => {
    // skip first line if needed
    let skipLine = hasHeaders;

    // @todo true streaming support for local files (use worker?)
    Papa.parse(file, {
      chunkSize: 100,
      skipEmptyLines: true,
      error: (error) => {
        reject(error);
      },
      chunk: ({ data }, parser) => {
        // pause to wait until the rows are consumed
        parser.pause();

        const skipped = skipLine && data.length > 0;

        const rows = (skipped ? data.slice(1) : data).map((row) => {
          const stringRow = (row as unknown[]).map((item) =>
            typeof item === 'string' ? item : ''
          );

          const record = {} as { [name: string]: string | undefined };

          fieldNames.forEach((fieldName) => {
            const columnIndex = fieldAssignments[fieldName];
            if (columnIndex !== undefined) {
              record[fieldName] = stringRow[columnIndex];
            }
          });

          return record as Row; // @todo look into a more precise setup
        });

        // clear line skip flag if there was anything to skip
        if (skipped) {
          skipLine = false;
        }

        // @todo collect errors
        reportProgress(rows.length);

        // wrap sync errors in promise
        // (avoid invoking callback if there are no rows to consume)
        const whenConsumed = new Promise<void>((resolve) =>
          resolve(rows.length ? callback(rows) : undefined)
        );

        // unpause parsing when done
        whenConsumed.then(
          () => {
            parser.resume();
          },
          () => {
            // @todo collect errors
            parser.resume();
          }
        );
      },
      complete: () => {
        resolve();
      }
    });
  });
}
