import * as path from 'path';

export type OutputPathExists = (candidatePath: string) => boolean;

/**
 * Return the first output path that does not already exist.
 *
 * The base path is preferred. If it is occupied, the numeric suffix is added
 * before the extension: `note.hwpx`, `note-1.hwpx`, `note-2.hwpx`, ...
 */
export function findAvailableOutputPath(
    outputPath: string,
    exists: OutputPathExists,
): string {
    if (!exists(outputPath)) {
        return outputPath;
    }

    const extension = path.extname(outputPath);
    const stem = extension.length > 0
        ? outputPath.slice(0, -extension.length)
        : outputPath;

    for (let sequence = 1; ; sequence += 1) {
        const candidate = `${stem}-${sequence}${extension}`;
        if (!exists(candidate)) {
            return candidate;
        }
    }
}
