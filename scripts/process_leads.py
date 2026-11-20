"""Join registration and scan CSVs by ticket ID and split leads by organization."""

import argparse
import re
from pathlib import Path
from urllib.parse import quote

import pandas as pd


REGISTRATION_COLUMN_ALIASES = {
    "full_name": "full_name",
    "fullname": "full_name",
    "name": "full_name",
    "email": "email",
    "phone": "phone",
    "school": "school",
    "grade": "Grade",
    "age": "Age",
    "intake_year": "intake_year",
    "consent_text": "consent_text",
    "consent": "consent_text",
    "submission_time": "submission_time",
    "time": "submission_time",
}

REPORT_COLUMN_LABELS = {
    "full_name": "fullName",
    "school": "School",
    "Grade": "Grade",
    "Age": "Age",
    "phone": "Phone",
    "email": "email",
    "intake_year": "intake_year",
    "consent_text": "consent",
    "submission_time": "time",
    "UUID": "UUID",
}

TICKET_COLUMN_ALIASES = ("uuid", "ticket_id", "ticketid", "id")
FORMULA_PREFIX = re.compile(r"^\s*['\s]*[=+\-@＝＋－＠]|^[\t\r\n]")
PLAIN_NUMBER = re.compile(r"[+-][0-9]+(?:\.[0-9]+)?")


def load_csv(path: Path) -> pd.DataFrame:
    """Keep ticket IDs, phone numbers, empty fields and event answers as text."""
    data = pd.read_csv(path, dtype=str, keep_default_na=False, encoding="utf-8-sig")
    data.columns = data.columns.str.strip()
    if data.columns.has_duplicates:
        raise ValueError(f"{path.name} has duplicate column headers.")
    return data.replace("\ufffd", "", regex=True)


def normalize_registration_columns(registrations: pd.DataFrame) -> pd.DataFrame:
    by_lowercase = {column.lower(): column for column in registrations}
    ticket_column = next(
        (
            by_lowercase[alias]
            for alias in TICKET_COLUMN_ALIASES
            if alias in by_lowercase
        ),
        None,
    )
    if ticket_column is None:
        raise ValueError("The registration CSV needs a UUID or ticket ID column.")

    names = {ticket_column: "UUID"}
    used = set(registrations.columns) | {"UUID"}
    for column in registrations:
        canonical = REGISTRATION_COLUMN_ALIASES.get(column.lower().replace(" ", "_"))
        if column != ticket_column and canonical and canonical not in used:
            names[column] = canonical
            used.add(canonical)

    registrations = registrations.rename(columns=names)
    registrations["UUID"] = registrations["UUID"].str.strip().str.upper()
    registrations = registrations[registrations["UUID"] != ""].drop_duplicates()
    if registrations["UUID"].duplicated().any():
        raise ValueError(
            "Multiple different registrations share a UUID. "
            "Resolve the duplicate tickets before exporting."
        )
    return registrations


def safe_csv_value(value: str) -> str:
    """Keep spreadsheet programs from executing formula-shaped form answers."""
    if FORMULA_PREFIX.match(value) and not PLAIN_NUMBER.fullmatch(value):
        return "'" + value
    return value


def generate_reports(
    registrations: pd.DataFrame, scans: pd.DataFrame, output_dir: Path
) -> None:
    if not {"Uni_ID", "UUID"}.issubset(scans.columns):
        raise ValueError("The raw scans CSV needs Uni_ID and UUID columns.")

    # Use only the scan identity columns. Registration columns, including
    # custom fields named Timestamp or Uni_ID, come from the private export.
    organization_column = "__scan_organization"
    while organization_column in registrations:
        organization_column += "_"
    scan_keys = scans[["Uni_ID", "UUID"]].rename(
        columns={"Uni_ID": organization_column}
    )
    scan_keys["UUID"] = scan_keys["UUID"].str.strip().str.upper()
    scan_keys[organization_column] = scan_keys[organization_column].str.strip()
    scan_keys = scan_keys[scan_keys[organization_column] != ""]
    matched = scan_keys[scan_keys["UUID"].isin(registrations["UUID"])]
    unmatched = len(scan_keys) - len(matched)
    if unmatched:
        print(
            f"WARNING: {unmatched} scans could not be matched to registrations "
            "and were omitted."
        )
    merged = matched.drop_duplicates().merge(
        registrations, on="UUID", validate="many_to_one"
    )

    # Preserve traQRecord's earlier report labels and order. Append each
    # additional source column in input order, without overwriting a field.
    columns = [column for column in REPORT_COLUMN_LABELS if column in registrations]
    columns.extend(column for column in registrations if column not in columns)
    labels = [REPORT_COLUMN_LABELS.get(column, column) for column in columns]
    if len(labels) != len(set(labels)):
        raise ValueError("Two registration fields would have the same report header.")

    groups = merged.groupby(organization_column, sort=True)
    filenames = {
        organization: f"leads_{quote(organization, safe='-_').replace('.', '%2E')}.csv"
        for organization in groups.groups
    }
    if len({name.casefold() for name in filenames.values()}) != len(filenames):
        raise ValueError("Two organization IDs would produce the same report filename.")

    output_dir.mkdir(parents=True, exist_ok=True)
    for organization, group in groups:
        report = group.loc[:, columns].map(safe_csv_value)
        report.columns = [safe_csv_value(label) for label in labels]
        report.to_csv(
            output_dir / filenames[organization], index=False, encoding="utf-8"
        )
        print(f"{filenames[organization]}: {len(report)} leads")

    print(f"Generated {len(filenames)} reports with {len(merged)} total leads.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "registrations", nargs="?", type=Path, default=Path("registrations.csv")
    )
    parser.add_argument("scans", nargs="?", type=Path, default=Path("raw_scans.csv"))
    parser.add_argument("--output-dir", type=Path, default=Path("reports"))
    args = parser.parse_args()

    try:
        registrations = normalize_registration_columns(load_csv(args.registrations))
        scans = load_csv(args.scans)
        generate_reports(registrations, scans, args.output_dir)
    except (OSError, ValueError) as error:
        parser.exit(1, f"ERROR: {error}\n")


if __name__ == "__main__":
    main()
