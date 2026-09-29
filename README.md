# submission-pipeline-service

Registers, downloads and imports automatic submissions ("meldingen") for the Loket
submission flow in a single process, without delta round-trips between the steps.

It replaces
[automatic-submission-service](https://github.com/lblod/automatic-submission-service),
[import-submission-service](https://github.com/lblod/import-submission-service) and, for
submissions only, [download-url-service](https://github.com/lblod/download-url-service).
The triples it writes are the same as before, so downstream services, the vendor
SPARQL API and the Loket frontend need no changes.

## Tutorials

### Add the service to a stack

Add the service to your `docker-compose.yml`:

```yaml
submission-pipeline:
  image: lblod/submission-pipeline-service
  environment:
    GRAPH_TEMPLATE: "http://mu.semte.ch/graphs/organizations/~ORGANIZATION_ID~/LoketLB-toezichtGebruiker"
  volumes:
    - ./data/files:/share
```

Mount the same volume the rest of the stack uses for files: `enrich-submission-service`
reads the harvested Turtle files from it.

Forward `/melding` to the service in the dispatcher:

```elixir
match "/melding/*path" do
  Proxy.forward conn, path, "http://submission-pipeline/melding"
end
```

The service needs no delta rules. After `tasko:import` succeeds,
[job-controller-service](https://github.com/lblod/job-controller-service) takes over
through its existing delta rules.

## Upgrading

### From automatic-submission-service, download-url-service and import-submission-service

1. **Check the job-controller configuration.** This service creates the `register`,
   `download` and `import` tasks itself. `job-controller-service` must not create any of
   those, and must start the task that follows `tasko:import`. A mistake here shows up
   as duplicate tasks, not as an error. Also check that no other job type uses
   `tasko:import`: `import-submission-service` ran every import task, this service only
   runs its own.
2. **Merge the environment variables.** Collect the variables of
   `automatic-submission`, `download-url` and `import-submission` from
   `docker-compose.yml` and any override files into the one `submission-pipeline`
   block. All names and defaults are kept. `GRAPH_TEMPLATE` was set on two services;
   make sure there is only one value. See [Environment variables](#environment-variables).
3. **Let download-url-service skip submissions.** Upgrade `download-url-service` to a
   version that supports `SKIP_CREATORS`, and set it to the creators of submission
   downloads:

   ```yaml
   download-url:
     environment:
       SKIP_CREATORS: "http://lblod.data.gift/services/automatic-submission-service,http://lblod.data.gift/services/import-submission-service"
   ```

   Otherwise both services download every submission. Keep `download-url-service` and
   its delta rule for the other flows that use it.
4. **Replace the services.** In the same deploy as step 3, remove the
   `automatic-submission` and `import-submission` services and add
   `submission-pipeline` as shown in [Add the service to a stack](#add-the-service-to-a-stack).
   Point the dispatcher rule for `/melding` to the new service.
5. **Update the delta rules.** Remove the rules that called
   `http://automatic-submission/download-status-update` (on `file-download-statuses`
   `ongoing`, `success` and `failure`) and `http://import-submission/delta` (on
   `tasko:import`).
6. **Check the submissions in flight.** On its first start the service takes over the
   busy jobs and unfinished downloads the old services left behind, including
   attachments, based on their triples. Jobs registered more than
   `RECONCILE_ABANDON_AFTER_DAYS` (default 7) ago are failed instead, so review the
   busy `jobo:automaticSubmissionFlow` jobs first.

Removed without replacement:

* `POST /download-status-update` and `POST /delta`: the steps call each other directly.
* `AUTOMATIC_SUBMISSION_JSON_LD_CONTEXT_ENDPOINT`: it was never read.

## How-to guides

### How to download from servers with an incomplete certificate chain

`download-url-service` bundled extra intermediate certificates for a few misconfigured
servers. This service uses Node's `fetch`, which ignores that mechanism. Mount a PEM
bundle with the missing certificates and point `NODE_EXTRA_CA_CERTS` to it:

```yaml
submission-pipeline:
  environment:
    NODE_EXTRA_CA_CERTS: /config/extra-ca.pem
  volumes:
    - ./config/submission-pipeline/extra-ca.pem:/config/extra-ca.pem
```

### How to recover submissions after a crash

Nothing needs to be done manually. The state of a submission is derived from the
triplestore, so on startup and every `RECONCILE_INTERVAL` seconds the service resumes or
fails interrupted jobs. See [Reconciliation](#reconciliation) for what happens in each
state. Failures show up as `oslc:Error`s in `http://mu.semte.ch/graphs/error`.

### How to run the tests

```bash
npm test
```

The tests run in the `mu-javascript-template` image from the `Dockerfile`, so Docker is
required.

## Reference

### Environment variables

| Name                                          | Description                                                                                                                                                      | Default                                                                               |
|-----------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------|
| `GRAPH_TEMPLATE`                              | Template for the submission graph. Must contain `~ORGANIZATION_ID~`.                                                                                             | `http://mu.semte.ch/graphs/organizations/~ORGANIZATION_ID~/LoketLB-toezichtGebruiker` |
| `SEND_ALERT_CLIENT_ERRORS`                    | Also write an `oslc:Error` for 4xx responses on `/melding`.                                                                                                      | `true`                                                                                |
| `USE_HASHED_KEY`                              | Match the vendor key against `muAccount:keyHash` (argon2) instead of `muAccount:key`.                                                                            | `false`                                                                               |
| `DEFAULT_GRAPH`                               | Graph for `ndo:DownloadEvent`s.                                                                                                                                  | `http://mu.semte.ch/graphs/public`                                                    |
| `FILE_STORAGE`                                | Directory where downloaded and harvested files are stored.                                                                                                       | `/share`                                                                              |
| `CACHING_MAX_RETRIES`                         | Download attempts before a download fails.                                                                                                                       | `30`                                                                                  |
| `DEFAULT_TEXT_FORMAT`                         | Extension for a downloaded text file of unknown type.                                                                                                            | `.txt`                                                                                |
| `REMOVE_AUTHENTICATION_SECRETS_AFTER_DOWNLOAD` | Delete a download's cloned credentials once it succeeds or fails. The misspelled `REMOVE_AUTHENTICATION_SECRETS_AFTER_DOWLOAD` is still accepted but deprecated. | `true`                                                                                |
| `VANDENBROELE_URI`                            | Vendor URI used to recognise Vandenbroele submissions.                                                                                                           | `http://data.lblod.info/vendors/b1e41693-639a-4f61-92a9-5b9a3e0b924e`                 |
| `APPLY_VANDENBROELE_FILENAME_WORKAROUND`      | Guess attachment filenames from the submission HTML for that vendor.                                                                                             | `false`                                                                               |
| `PING_DB_INTERVAL`                            | Seconds between checks while waiting for the database at startup, before reconciliation runs.                                                                    | `2`                                                                                   |
| `DOWNLOAD_CONCURRENCY`                        | *New.* Maximum number of download attempts and imports running at once, attachments included. Waiting for a retry doesn't count.                                 | `5`                                                                                   |
| `RECONCILE_ON_BOOT`                           | *New.* Run [reconciliation](#reconciliation) at startup.                                                                                                         | `true`                                                                                |
| `RECONCILE_INTERVAL`                          | *New.* Seconds between periodic reconciliation runs. `0` disables them.                                                                                          | `3600`                                                                                |
| `STALE_TASK_TIMEOUT_HOURS`                    | *New.* Hours a busy task must be idle before periodic reconciliation touches it.                                                                                 | `1`                                                                                   |
| `RECONCILE_ABANDON_AFTER_DAYS`                | *New.* Days after registration after which reconciliation fails a job instead of resuming it.                                                                    | `7`                                                                                   |

### API

The API is unchanged from `automatic-submission-service`. The
[Meldingsplicht API documentation](https://lblod.github.io/pages-vendors/#/docs/submission-api)
describes the request bodies and error codes.

#### POST /melding

Registers a submission and starts downloading and importing it in the background.
Accepts `application/json` and `application/ld+json`. Responds with `201 Created` once
the submission is registered:

```json
{
  "uri": "http://data.lblod.info/submissions/e5725210-…",
  "submission": "http://data.lblod.info/submissions/e5725210-…",
  "job": "http://data.lblod.info/id/automatic-submission-job/e58a4fd0-…"
}
```

Responds with `409 Conflict` if the `submittedResource` already exists.

#### POST /status

Returns the status of a submission's job as JSON-LD. Limited to 5 requests per minute
per submission. Vendors should prefer the
[Vendor SPARQL API](https://lblod.github.io/pages-vendors/#/docs/vendor-sparql-api).

### Pipeline

```
POST /melding
     │
     ▼
 register ──► download ──► import ──► job-controller-service (enrich, validate, …)
 index "0"    index "1"    index "2"
                              │
                              └──► attachments (background, no task)
```

All three tasks belong to one `cogs:Job` with operation `jobo:automaticSubmissionFlow`,
in the organisation's submission graph. The service leaves the job at `js:busy`;
`job-controller-service` continues after `tasko:import`.

Downloads retry with exponential backoff, as in `download-url-service`: with the
default `CACHING_MAX_RETRIES` a failing download is given up after about 4.4 days. A
download waiting for its next attempt doesn't take up a `DOWNLOAD_CONCURRENCY` slot.

### Submission states

A submission's state is derived from its tasks, never stored, so it also works for
submissions created by the old services.

| State         | Derived from                                                           |
|---------------|------------------------------------------------------------------------|
| `REGISTERING` | `tasko:register` is `js:busy`                                          |
| `SCHEDULED`   | `tasko:register` is `js:success`, `tasko:download` is `js:scheduled`   |
| `DOWNLOADING` | `tasko:download` is `js:busy`                                          |
| `DOWNLOADED`  | `tasko:download` is `js:success`, `tasko:import` absent or `js:scheduled` |
| `IMPORTING`   | `tasko:import` is `js:busy`                                            |
| `IMPORTED`    | `tasko:import` is `js:success`                                         |
| `FAILED`      | any of the tasks is `js:failed`                                        |

### Reconciliation

Reconciliation looks at every `jobo:automaticSubmissionFlow` job at `js:busy` that
hasn't finished its import, skipping jobs this process is already working on. At
startup it handles all of them; periodic runs only handle jobs whose task has been idle
for `STALE_TASK_TIMEOUT_HOURS`. For `DOWNLOADING`, the expected backoff of the current
retry is added to that timeout.

Jobs registered more than `RECONCILE_ABANDON_AFTER_DAYS` ago are failed instead of
resumed, so an old backlog is not processed unnoticed after an incident.

| State         | Action                                                                                 |
|---------------|----------------------------------------------------------------------------------------|
| `REGISTERING` | Fail the job: the request body is gone and the vendor must resubmit.                   |
| `SCHEDULED`   | Start the download, then the import.                                                   |
| `DOWNLOADING` | Resume the existing `ndo:DownloadEvent` at its current retry count, then import.       |
| `DOWNLOADED`  | Run the import.                                                                        |
| `IMPORTING`   | Remove the partially written Turtle file and its triples, then run the import again. Attachments created by the interrupted run are reused. |
| other         | Nothing.                                                                               |

When reconciliation acts on a job with duplicate task indexes or tasks busy past
`STALE_TASK_TIMEOUT_HOURS`, it reports the job as inconsistent in the error graph.

Attachments have no task, so reconciliation also resumes attachment downloads that are
still `ready-to-be-cached` or `ongoing`, from their last download event. The same timing rules
apply: at startup all of them, periodically only those older than
`STALE_TASK_TIMEOUT_HOURS`, and none older than `RECONCILE_ABANDON_AFTER_DAYS`.

### Data model

All triples go to the submission graph (`GRAPH_TEMPLATE` for the organisation) unless
stated otherwise. Prefixes are defined in [`lib/constants.js`](lib/constants.js).

#### Register

* **Job** `asj:<uuid>`, `a cogs:Job`: `mu:uuid`, `dct:creator
  services:automatic-submission-service`, `adms:status js:busy`, `dct:created`,
  `dct:modified`, `task:cogsOperation cogs:TransformationProcess`, `task:operation
  jobo:automaticSubmissionFlow`, `prov:generated <submission>`.
* **Register task** `asj:<uuid>`, `a task:Task`: `task:operation tasko:register`,
  `task:index "0"`, `dct:isPartOf <job>`, `adms:status` `js:busy` → `js:success`, and a
  `task:resultsContainer` whose `hrvst:HarvestingCollection` has `dct:hasPart
  <remote data object>`.
* **Submission** `a meb:Submission`: the request body without the vendor's triples, plus
  `mu:uuid`, `dct:created`, `dct:modified` and `nie:hasPart <remote data object>`.
* **Submitted resource**: `a foaf:Document, ext:SubmissionDocument`, and a `mu:uuid` if it
  has none.
* **Remote data object** `a nfo:RemoteDataObject, nfo:FileDataObject`: `nie:url`,
  `rpioHttp:requestHeader` (Accept `text/html`), `dct:creator
  services:automatic-submission-service`, `adms:status
  file-download-statuses:ready-to-be-cached`. If the request contained credentials, a copy is
  linked with `dgftSec:targetAuthenticationConfiguration`.
* **Download task**: `task:operation tasko:download`, `task:cogsOperation
  cogs:WebServiceLookup`, `task:index "1"`, `adms:status js:scheduled`, with the same
  harvesting collection as `task:inputContainer`.

#### Download

* **Download event** `a ndo:DownloadEvent`, in `DEFAULT_GRAPH`: `adms:status`,
  `task:numberOfRetries`, `dct:creator services:download-url-service`, `nuao:involves`
  the remote data object and, on success, the local file.
* **Remote data object**: `adms:status` `ongoing` → `success` or `failure`,
  `ext:httpStatusCode`, `ext:cacheError` on failure. On success it also gets the
  local file's `nfo:fileName`, `dct:format`, `nfo:fileSize`, `dbpedia:fileExtension` and
  `dct:created`.
* **Local file** `share://<uuid>.<ext>`, `a nfo:FileDataObject, nfo:LocalFileDataObject`:
  `nie:dataSource` and `ndo:copiedFrom` the remote data object.
* **Download task**: `js:busy` → `js:success`, with a `task:resultsContainer` that
  `task:hasFile` the remote data object. On failure the task and job become `js:failed`
  with a `task:error`.
* **Import task**: created on success, with `task:operation tasko:import`, `task:index
  "2"`, `adms:status js:scheduled` and an input container that `task:hasFile` the remote
  data object.

#### Import

* **Harvested data**: the RDFa of the publication, enriched with the broader SKOS types
  of every type, the publication URL (for the form's link field), the classifications of
  the bestuursorgaan and bestuurseenheid, the path to the meeting date for VGC, and a
  `dct:hasPart` per attachment.
* **Turtle file** `share://submissions/<uuid>.ttl` plus a logical file `asj:<uuid>`,
  both `dct:type <http://data.lblod.gift/concepts/harvested-data>` and `dct:creator
  services:import-submission-service`. The submitted resource gets `dct:source` the
  physical file.
* **Import task**: `js:busy` → `js:success`, with a `task:resultsContainer` that
  `task:hasFile` the logical Turtle file.
* **Attachments**: one remote data object per attachment URL, `dct:creator
  services:import-submission-service`, linked with `nie:hasPart` from the submission,
  with its own copy of the credentials. Downloads follow the same model as the
  publication.

## Discussions

### Why one service

The old flow spread one submission over three services, connected by deltas. Every
hand-off added a delta round-trip, and a missed delta could leave a submission stuck
unnoticed. Running the steps in one process removes that latency and makes the
state of a submission something the service can inspect and recover itself.

### Coexistence with download-url-service

This service writes the same download statuses as before, so `download-url-service`
would also download every submission. Instead of changing the data, `download-url-service`
is configured to skip remote data objects by their `dct:creator` (`SKIP_CREATORS`). The
creators of submission downloads are unchanged, so this also hands over the downloads the
old services left unfinished, and other flows keep using `download-url-service` as
before. That includes links in submissions made in Loket itself, which have
`dct:creator` `validate-submission-service`.

The creators and statuses must stay unchanged: Loket's frontend tells publications and
attachments apart by creator, and shows `ready-to-be-cached` as a download in
progress.

### Attachments are best-effort

Attachment URLs are only known after the publication is harvested, and the Turtle only
needs a link to them. The import task therefore succeeds without waiting for attachment
downloads, as it did with `import-submission-service`. Attachments have no task, and a
failed attachment download does not fail the submission.

### Single replica

The service assumes it runs as one replica, like the services it replaces. Reconciliation
has no locking, so two replicas could resume the same job twice.

### Known limitations

Most of these are inherited from the old services:

* One publication file per submission.
* The `409` check only looks for any triple about the `submittedResource`, and two
  simultaneous requests for the same resource can both pass it.
* Download events live in `DEFAULT_GRAPH`, everything else in the organisation graph.
* Cloned credentials are not removed if a flow never finishes.
* RDFa is extracted with [marawa](https://github.com/lblod/marawa), which drops language
  tags. Replacing it (for example with rdflib.js) changes the harvested triples and needs
  its own migration.
