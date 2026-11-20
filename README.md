# traQRecord

traQRecord collects scans for education events, fairs and partner visits. Each event uses a registration workbook, a separate scanner workbook and an Apps Script deployment bound to the scanner workbook.

## Data flow

1. The registration form sends the event fields to n8n. The workflow writes a complete registration with its ticket ID, then makes that ID available to the scanner and sends the matching QR code.
2. An organizer creates a credentialed link for each organization. The browser queues scans offline and posts them to Apps Script when online. The receiver verifies the organization's credential and the ticket ID, then records one scan per organization and ticket.
3. An organizer joins the two CSV exports locally by UUID and produces a report for each organization that scanned a registered lead.

## Set up an event

### Registration workbook and n8n

Keep the registration workbook restricted to the people and automation that need access to the full registration data. The registration export requires a unique `UUID` or `ticket_id` column. The current QR contract is eight uppercase alphanumeric characters.

The DXJ China event workflow, `dxj-china-event`, already writes its generated `ticket_id` into `china-event-leads.UUID`. Its registration columns are `submission_time`, `full_name`, `email`, `phone`, `Age`, `consent`, `study-level`, `intake year` and `UUID`.

The published DXJ workflow includes `Save scanner ticket UUID` after the registration append. It upserts only `UUID` as raw text into `valid_tickets`. The confirmation path waits for the scanner write and receives the original registration item. At publication, the registration and scanner UUID lists matched across 84 existing tickets.

Avoid granting `IMPORTRANGE` access from the scanner workbook to the registration workbook. That grant would let scanner-workbook editors change the import range to read other registration columns. Keep the Apps Script scanner bound to its own data.

### Scanner workbook

Create a restricted, separate Google Sheets file with these exact tab names and header rows.

| Tab | Headers |
| --- | --- |
| `Raw_Scans` | `Timestamp`, `Uni_ID`, `UUID` |
| `participant_url` | `Participant_Name`, `Participant_ID`, `Token_Hash`, `Active`, `Scanner_URL` |
| `valid_tickets` | `UUID` |

Keep ID columns formatted as plain text. Backfill only the IDs of registrations for the same event. A scanner URL contains a bearer credential. Share each link privately with its organization. Give workbook access to organizers and the automation account only as needed.

### Apps Script and scanner deployment

1. In the scanner workbook, open **Extensions → Apps Script**. Add `Code.gs` and `ParticipantLinks.gs`, then run `setup()` from the editor to validate the schema and record the workbook ID.
2. Add each organization's name and distinct, stable ID in the first two columns of `participant_url`. Run `generateParticipantUrls()` from the editor. It fills the token hash, active flag and link for new rows and preserves links that already exist.
3. Deploy the Apps Script as a Web App, executing as the owner, with access set to **Anyone**. The GET route is non-mutating. Scan uploads require both a matching active participant credential and a registered ticket.
4. Set `API_URL` in `index.html` to this event's Web App `/exec` URL. Use a test deployment and follow [TESTING.md](TESTING.md) before publishing the scanner through GitHub Pages.
5. Distribute the generated links. They use `?uni=<Participant_ID>#token=<credential>` on the traQRecord Pages URL. A bare `?uni=` link cannot open the scanner. Set `Active` to false to disable a link or run `rotateSelectedParticipantUrl()` with one participant row selected. Cached authorization can persist for up to 60 seconds.

Before replacing an older deployed scanner, confirm its devices have synchronized any pending scans. The new offline queue is scoped to the deployment and participant and keeps the credential in the link. Keep the old export available if you need to recover historical scans.

## Export leads

Export the registration tab as `registrations.csv` and the same event's scanner `Raw_Scans` tab as `raw_scans.csv`. Keep both exports and the resulting lead reports in restricted storage. `participant_url` and `valid_tickets` are used by the scanner only.

```powershell
python -m pip install --require-hashes -r requirements.lock
python scripts/process_leads.py registrations.csv raw_scans.csv --output-dir reports/dxj-china
```

Without arguments, the script reads `registrations.csv` and `raw_scans.csv` and writes to `reports`. Use a fresh output directory per event or export run so files from an earlier run do not get mixed with the current results.

Each CSV contains one row per matched UUID scanned by that organization. The same lead can appear in multiple organization files if each of those organizations scanned the lead. The script omits unmatched scans and reports their count. It stops on conflicting registration records for one UUID. It keeps the existing report labels for common fields, appends custom registration fields and preserves text such as leading zeros. Formula-shaped input values are escaped for opening the CSVs in a spreadsheet.

## Repository

- `index.html` is the GitHub Pages scanner.
- `Code.gs` receives and verifies scans.
- `ParticipantLinks.gs` generates and rotates organization scanner links.
- `scripts/process_leads.py` joins the CSVs and creates organization reports.
- `requirements.txt` declares Python dependencies. `requirements.lock` pins the hash-verified install.
- `email-templates/confirmation-email.html` is a starter template for the QR confirmation.
