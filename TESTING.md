# traQRecord verification

Run from the repository root.

```powershell
node --test tests/*.js
python -m unittest discover -s tests -p '*_test.py'
git diff --check
```

The automated tests use synthetic records. They exercise the browser queue, Apps Script authorization, organization link generation and CSV export.

## End-to-end smoke on a test deployment

1. Use a test registration workbook and scanner workbook. Register a disposable lead and verify the same ticket appears in both files before the test confirmation email arrives.
2. Create two test participant rows and generate their links. Open each link on a phone and verify the correct scan target and camera view. Open a bare `?uni=TEST` link and verify it displays a configuration error.
3. Scan the test QR while offline, reconnect and verify the scanner reports synchronization only after the receiver confirms the write. Retry the scan with the same organization and verify that it does not create a second row.
4. Scan the same QR with the second organization's link and verify both organization IDs appear in separate rows in `Raw_Scans`. An unregistered QR should be rejected. Disabling a participant should prevent its link from writing after its authorization cache expires.
5. Run the CSV export against these test files and verify each organization receives the test lead and every registration field.

The historical GET-based load-test script and artifacts were written for the previous scanner protocol. Use the current automated tests and a dedicated test deployment for validation.
