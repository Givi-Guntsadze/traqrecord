import csv
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "process_leads.py"


class LeadReportsTest(unittest.TestCase):
    def test_exports_full_registration_for_each_matching_organization(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "registrations.csv").write_text(
                "submission_time,full_name,email,phone,Age,consent,"
                "study-level,intake year,UUID,Custom Field\n"
                "first,,alex@example.test,+995012345678,19,yes,"
                "Masters,2027,00001234,NA\n"
                "second,Jamie,jamie@example.test,00123,21,yes,"
                "Bachelors,2026,ABCDEFGH,001\n",
                encoding="utf-8",
            )
            (root / "raw_scans.csv").write_text(
                "Timestamp,Uni_ID,UUID\n"
                "one,ORG_A,00001234\n"
                "two,ORG_A,00001234\n"
                "three,ORG_B,00001234\n"
                "four,ORG_B,abcdefgh\n"
                "five,ORG_C,ZZZZZZZZ\n",
                encoding="utf-8",
            )

            result = subprocess.run(
                [sys.executable, str(SCRIPT)],
                cwd=root,
                check=True,
                capture_output=True,
                text=True,
            )
            reports = root / "reports"
            self.assertEqual(
                {file.name for file in reports.glob("*.csv")},
                {"leads_ORG_A.csv", "leads_ORG_B.csv"},
            )
            with (reports / "leads_ORG_A.csv").open(
                encoding="utf-8", newline=""
            ) as file:
                rows_a = list(csv.DictReader(file))
            with (reports / "leads_ORG_B.csv").open(
                encoding="utf-8", newline=""
            ) as file:
                rows_b = list(csv.DictReader(file))

            self.assertEqual(len(rows_a), 1)
            self.assertEqual(rows_a[0], rows_b[0])
            self.assertEqual(rows_a[0]["fullName"], "")
            self.assertEqual(rows_a[0]["Phone"], "+995012345678")
            self.assertEqual(rows_a[0]["study-level"], "Masters")
            self.assertEqual(rows_a[0]["Custom Field"], "NA")
            self.assertEqual(rows_a[0]["UUID"], "00001234")
            self.assertEqual(rows_b[1]["Phone"], "00123")
            self.assertEqual(rows_b[1]["Custom Field"], "001")
            self.assertIn("1 scans could not be matched", result.stdout)


if __name__ == "__main__":
    unittest.main()
