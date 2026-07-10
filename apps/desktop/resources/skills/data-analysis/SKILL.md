---
name: data-analysis
description: Explore, clean, aggregate, and summarize tabular data (CSV / TSV / Parquet / JSON) with pandas. Use when the user wants to analyze a dataset, compute statistics, group/pivot/join tables, find trends or outliers, or turn raw rows into a clear summary or chart.
license: MIT (© 2026 Pi Desktop contributors)
---

# Data analysis

Turn a tabular dataset into answers. Work in Python with pandas; keep the analysis
reproducible and state assumptions explicitly.

## Load & understand before analyzing

```python
import pandas as pd
df = pd.read_csv(path)          # or read_parquet / read_json / read_excel
df.shape, df.head(), df.dtypes  # size, sample, types
df.describe(include="all")      # numeric + categorical summary
df.isna().sum()                 # missingness per column
```

Always look at the data first: row/column counts, dtypes, a sample, missing values,
and the cardinality of key columns. Confirm what one row represents.

## Clean

- Fix dtypes: `pd.to_datetime`, `pd.to_numeric(errors="coerce")`, category casts.
- Handle missing values *deliberately* — drop, fill, or flag — and say which and why.
- Normalize strings (strip/case), dedupe (`df.drop_duplicates`), and check ranges
  for impossible values (negative ages, future dates).

## Aggregate & analyze

- Group/pivot: `df.groupby(keys).agg(...)`, `df.pivot_table(...)`.
- Join carefully: `df.merge(other, on=..., how=...)` — verify row counts before/after
  and watch for many-to-many blowups.
- Trends: resample time series (`df.set_index(ts).resample("D").sum()`); rank with
  `nlargest`/`nsmallest`; outliers via IQR or z-score.

## Summarize honestly

- Report the numbers that answer the question, with units and the denominator.
- Note caveats: sample size, missing data, selection bias, correlation ≠ causation.
- Round for readability but keep precision where it matters.
- If a chart helps, produce one (bar for categories, line for time, histogram for
  distributions) and describe the takeaway in one sentence.

## Guardrails

- Don't silently drop rows — count what you exclude and mention it.
- Distinguish "no data" from "zero". Keep raw and derived columns separate.
- Prefer vectorized pandas over Python loops for anything sizable.
