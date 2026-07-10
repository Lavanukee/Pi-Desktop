---
name: spreadsheet-toolkit
description: Read, edit, format, and analyze spreadsheets (.xlsx / .csv) with open-source Python libraries. Use when the user wants to open a workbook, transform or clean rows, write formulas, add formatting or charts, or convert between CSV and Excel. A permissive (MIT) alternative to proprietary spreadsheet skills.
license: MIT (© 2026 Pi Desktop contributors)
---

# Spreadsheet toolkit

Work with spreadsheets in Python. Choose the tool by task:

- **pandas** — bulk data: read/clean/transform/aggregate, convert CSV↔Excel.
- **openpyxl** — `.xlsx` structure: cell formatting, formulas, multiple sheets,
  charts, merged cells, styles.

## Read

```python
import pandas as pd
df = pd.read_excel(path, sheet_name=0)   # or read_csv
xls = pd.ExcelFile(path); xls.sheet_names # list tabs
```

Check `df.shape`, `df.head()`, `df.dtypes`, and header row correctness before editing.

## Transform & analyze (pandas)

- Clean: fix dtypes, trim strings, `drop_duplicates`, handle NaNs deliberately.
- Reshape: `groupby().agg()`, `pivot_table`, `merge`.
- Compute new columns vectorized (avoid per-row Python loops).

## Write with formatting, formulas, charts (openpyxl)

```python
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
from openpyxl.chart import BarChart, Reference
wb = Workbook(); ws = wb.active
ws.append(["Region", "Sales"])
for row in data: ws.append(row)
ws["B1"].font = Font(bold=True)
ws["B99"] = "=SUM(B2:B98)"        # formula, evaluated by Excel on open
chart = BarChart()
chart.add_data(Reference(ws, min_col=2, min_row=1, max_row=98), titles_from_data=True)
ws.add_chart(chart, "D2")
wb.save("out.xlsx")
```

Preserve existing formatting by editing with `load_workbook(path)` rather than
rebuilding from scratch.

## Convert

- CSV → Excel: `pd.read_csv(p).to_excel("out.xlsx", index=False)`.
- Excel → CSV (one sheet): `pd.read_excel(p, sheet_name="X").to_csv("out.csv", index=False)`.

## Guardrails

- Formulas written by openpyxl are stored, not computed — Excel evaluates them on
  open; pandas won't. For computed values, calculate in Python.
- Watch Excel's type coercion (leading zeros, dates, large ints as floats). Keep IDs
  as strings.
- For very large files, read in chunks or use `read_only=True` (openpyxl) to bound
  memory.
