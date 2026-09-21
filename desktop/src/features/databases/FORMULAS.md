# Database formula reference

Database formulas use exact, case-sensitive property names such as
`prop("Effort")`. Conditions accept booleans only. `if`, `ifs`, `? :`, `and`,
`or`, and `not` are lazy where a branch can be skipped. Arithmetic never turns
text, booleans, lists, or empty values into numbers implicitly.

| Names | Arguments and result |
| --- | --- |
| `empty` | One value. `null`, `0`, `""`, and `[]` are empty; `false` is not. |
| `length` | One text or list value; returns its length. |
| `substring` | Text, zero-based start, and optional end; end is exclusive. |
| `contains` | Text/list and a value; list comparison uses the same strict type. |
| `lower`, `upper`, `trim` | One text value. `trim` changes only leading/trailing whitespace. |
| `format` | One primitive, date, or list; returns bounded stable text without locale styling. |
| `add`, `subtract`, `multiply` | Two finite numbers. The `+`, `-`, and `*` operators use the same rule. |
| `divide`, `mod`, `pow` | Two finite numbers. Zero division and non-finite results are errors; `/`, `%`, and `^` match. |
| `min`, `max`, `sum`, `mean` | One or more numbers or one-level number lists; `null` entries are ignored. `sum([])` is `0`; the other empty aggregates are `null`. |
| `abs`, `ceil`, `floor`, `sqrt` | One finite number. Domain and non-finite results are errors. |
| `round` | A finite number and optional integer digits from -15 through 15. |
| `pi` | No arguments; returns π. |
| `toNumber` | Complete finite decimal text, a boolean, a finite number, or a date timestamp. |
| `at` | List and zero-based integer index; a missing item is `null`. |
| `first`, `last` | One list; an empty list returns `null`. |
| `slice` | List, zero-based start, and optional end. |
| `concat` | One or more lists; preserves order within the 1,000-item bound. |
| `join` | Text list and text separator; returns bounded text. |
| `split` | Text and text separator; returns at most 1,000 text items. |
| `includes` | List and a value; uses strict same-type equality. |
| `id` | No arguments; returns the current row UUID. |
| `parseDate` | Strict `YYYY-MM-DD` or an ISO timestamp with `Z`/explicit offset. |
| `dateRange` | Two dates of the same mode; end must not precede start. |
| `dateStart`, `dateEnd` | One date/range; `dateEnd` of a single date returns its start. |
| `timestamp` | One date; returns epoch milliseconds. |
| `now`, `today` | No arguments; one shared evaluation clock. `today` is a UTC date-only value. |
| `dateAdd`, `dateSubtract` | Date, integer amount, and year/quarter/month/week/day/hour/minute unit. Month/year math clamps; timed offsets are preserved. |
| `dateBetween` | Two matching-mode dates and a supported unit; returns completed UTC units for left minus right. |

The runtime also supports strict `==`, `!=`, `>`, `>=`, `<`, and `<=`.
Date-only values compare as calendar dates, timed values compare as instants,
and mixing those modes is an error. All extraction and date arithmetic uses UTC;
timed display keeps the source offset.

Formula text is limited to 4,096 UTF-8 bytes, 512 tokens, nesting depth 32,
64 property references, and bounded output. Computed results are never stored in
row events. Errors remain visible as codes such as `TYPE_MISMATCH`,
`DIVIDE_BY_ZERO`, `CYCLE`, `BROKEN_RELATION`, and `SOURCE_INCOMPLETE`.

Regex, rich-text styling, locale formatting, profile lookup, higher-order list
functions, variables, member/index access, assignment, user functions,
factorial, `in`, random values, and Formula.js names outside this table are not
supported in the initial formula tier.
