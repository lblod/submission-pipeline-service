import { registerSubmission } from './register.js';
import { performDownload } from './download.js';
import { performImport } from './import.js';

const activeJobs = new Set();

/** Whether this process is working on the job, possibly waiting for a retry. */
export function isJobActive(jobUri) {
  return activeJobs.has(jobUri);
}

/**
 * Run a job's remaining steps in the background, tracked so reconciliation leaves
 * the job alone meanwhile.
 *
 * @param {string} jobUri
 * @param {() => Promise<any>} work
 */
export function runJobInBackground(jobUri, work) {
  activeJobs.add(jobUri);
  work()
    .catch((error) => {
      // Steps report their own failures (alreadyStoredError). This only keeps an
      // unexpected error from becoming an unhandled rejection that kills the process.
      if (!error.alreadyStoredError) {
        console.error(
          `Unexpected error in background work for job ${jobUri}: ${error.message}`,
        );
        console.error(error);
      }
    })
    .finally(() => activeJobs.delete(jobUri));
}

/**
 * Registers a submission, then runs download and import in the background.
 *
 * @param {object} params
 * @param {import('n3').Store} params.store parsed /melding request body
 * @param {string} params.submissionGraph
 * @returns {Promise<{submissionUri: string, jobUri: string}>} resolves once register
 *   completes; download+import are already running in the background by then
 */
export async function submitPipeline({ store, submissionGraph }) {
  const registerResult = await registerSubmission({ store, submissionGraph });
  const { submissionUri, jobUri, downloadTaskUri, remoteDataObjectUri, url } =
    registerResult;

  // Not awaited: the vendor gets a response once registration succeeds.
  runJobInBackground(jobUri, () =>
    runDownloadThenImport({
      jobUri,
      downloadTaskUri,
      remoteDataObjectUri,
      submissionGraph,
      url,
    }),
  );

  return { submissionUri, jobUri };
}

async function runDownloadThenImport({
  jobUri,
  downloadTaskUri,
  remoteDataObjectUri,
  submissionGraph,
  url,
}) {
  const { importTaskUri } = await performDownload({
    jobUri,
    downloadTaskUri,
    remoteDataObjectUri,
    submissionGraph,
    url,
  });
  await performImport({
    jobUri,
    importTaskUri,
    remoteDataObjectUri,
    submissionGraph,
  });
}
