import fetch from "node-fetch";
import * as vscode from "vscode";
import * as stream from "stream";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as util from "util";
import { log, assert } from "./util";

const pipeline = util.promisify(stream.pipeline);

const GITHUB_API_ENDPOINT_URL = "https://api.github.com";
const OWNER = "rust-analyzer";
const REPO = "rust-analyzer";

export async function fetchRelease(
    releaseTag: string
): Promise<GithubRelease> {

    const apiEndpointPath = `/repos/${OWNER}/${REPO}/releases/tags/${releaseTag}`;

    const requestUrl = GITHUB_API_ENDPOINT_URL + apiEndpointPath;

    log.debug("Issuing request for released artifacts metadata to", requestUrl);

    const response = await fetch(requestUrl, { headers: { Accept: "application/vnd.github.v3+json" } });

    if (!response.ok) {
        log.error("Error fetching artifact release info", {
            requestUrl,
            releaseTag,
            response: {
                headers: response.headers,
                status: response.status,
                body: await response.text(),
            }
        });

        throw new Error(
            `Got response ${response.status} when trying to fetch ` +
            `release info for ${releaseTag} release`
        );
    }

    // We skip runtime type checks for simplicity (here we cast from `any` to `GithubRelease`)
    const release: GithubRelease = await response.json();
    return release;
}

// We omit declaration of tremendous amount of fields that we are not using here
export interface GithubRelease {
    name: string;
    id: number;
    // eslint-disable-next-line camelcase
    published_at: string;
    assets: Array<{
        name: string;
        // eslint-disable-next-line camelcase
        browser_download_url: string;
    }>;
}

interface DownloadOpts {
    progressTitle: string;
    url: string;
    dest: string;
    mode?: number;
}

export async function download(opts: DownloadOpts) {
    // Put the artifact into a temporary folder to prevent partially downloaded files when user kills vscode
    await withTempDir(async tempDir => {
        const tempFile = path.join(tempDir, path.basename(opts.dest));

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                cancellable: false,
                title: opts.progressTitle
            },
            async (progress, _cancellationToken) => {
                let lastPercentage = 0;
                await downloadFile(opts.url, tempFile, opts.mode, (readBytes, totalBytes) => {
                    const newPercentage = (readBytes / totalBytes) * 100;
                    progress.report({
                        message: newPercentage.toFixed(0) + "%",
                        increment: newPercentage - lastPercentage
                    });

                    lastPercentage = newPercentage;
                });
            }
        );

        await moveFile(tempFile, opts.dest);
    });
}

/**
 * Downloads file from `url` and stores it at `destFilePath` with `mode` (unix permissions).
 * `onProgress` callback is called on recieveing each chunk of bytes
 * to track the progress of downloading, it gets the already read and total
 * amount of bytes to read as its parameters.
 */
async function downloadFile(
    url: string,
    destFilePath: fs.PathLike,
    mode: number | undefined,
    onProgress: (readBytes: number, totalBytes: number) => void
): Promise<void> {
    const res = await fetch(url);

    if (!res.ok) {
        log.error("Error", res.status, "while downloading file from", url);
        log.error({ body: await res.text(), headers: res.headers });

        throw new Error(`Got response ${res.status} when trying to download a file.`);
    }

    const totalBytes = Number(res.headers.get('content-length'));
    assert(!Number.isNaN(totalBytes), "Sanity check of content-length protocol");

    log.debug("Downloading file of", totalBytes, "bytes size from", url, "to", destFilePath);

    let readBytes = 0;
    res.body.on("data", (chunk: Buffer) => {
        readBytes += chunk.length;
        onProgress(readBytes, totalBytes);
    });

    const destFileStream = fs.createWriteStream(destFilePath, { mode });
    await pipeline(res.body, destFileStream);
    await new Promise<void>(resolve => {
        destFileStream.on("close", resolve);
        destFileStream.destroy();
        // This workaround is awaiting to be removed when vscode moves to newer nodejs version:
        // https://github.com/rust-analyzer/rust-analyzer/issues/3167
    });
}

async function withTempDir(scope: (tempDirPath: string) => Promise<void>) {
    // Based on the great article: https://advancedweb.hu/secure-tempfiles-in-nodejs-without-dependencies/

    // `.realpath()` should handle the cases where os.tmpdir() contains symlinks
    const osTempDir = await fs.promises.realpath(os.tmpdir());

    const tempDir = await fs.promises.mkdtemp(path.join(osTempDir, "rust-analyzer"));

    try {
        return await scope(tempDir);
    } finally {
        // We are good citizens :D
        void fs.promises.rmdir(tempDir, { recursive: true }).catch(log.error);
    }
};

async function moveFile(src: fs.PathLike, dest: fs.PathLike) {
    try {
        await fs.promises.rename(src, dest);
    } catch (err) {
        if (err.code === 'EXDEV') {
            // We are probably moving the file across partitions/devices
            await fs.promises.copyFile(src, dest);
            await fs.promises.unlink(src);
        } else {
            log.error(`Failed to rename the file ${src} -> ${dest}`, err);
            throw err;
        }
    }
}
