# RSVP guest-list intake and CSV

Candidary's manager **Add guests** workspace accepts mapped CSV or tabular data,
one name per line, spreadsheet paste, and direct typing. It is additive: a batch
may create households or append guests and plus-one capacity to a household the
host explicitly selects, but it never synchronizes, overwrites, removes, merges,
or moves committed roster data.

The exact CSV format below remains accepted by that workspace without a mapping
step. The original strict import API also remains available for compatibility;
that API may commit only once on a pristine event while RSVP is disabled. The
manager workspace always uses the newer additive preview/commit contract, even
for this exact header, so an unchanged retry can replay a durable receipt.

## The strict CSV format

- UTF-8, with or without a byte order mark.
- At most **256 KB**. A 500-person list is far under this.
- LF or CRLF line endings. A trailing newline is fine.
- Standard CSV quoting: wrap a field in `"` if it contains a comma or a quote,
  and double a quote inside a quoted field (`"Avery ""AJ"" Rivera"`).

The first line must be exactly:

```
household_key,household_label,invitee_name,plus_one_slots
```

Four columns, that spelling, that order. Extra columns are refused rather than
ignored, so a file exported with a `meal` column comes back as a problem you can
see instead of a silently dropped field.

## The rows

**One row per named guest.** A household with three named people is three rows
that repeat the same `household_key`, `household_label`, and `plus_one_slots`.

```csv
household_key,household_label,invitee_name,plus_one_slots
perkins,Perkins household,Henry Perkins,1
perkins,Perkins household,Jordan Perkins,1
rivera,Rivera household,Avery Rivera,0
```

That file invites five people: three named guests and two plus-one slots.

| Column | Rule |
| --- | --- |
| `household_key` | An optional advanced stable identifier in mapped intake, and required by the strict compatibility format. Lowercase letters, digits, `-`, and `_`; must start with a letter or digit; 1–64 characters. It is never shown to guests. |
| `household_label` | What the household is called on your list. 1–80 characters. Repeated rows must use the same label. |
| `invitee_name` | One named guest, as they would type it. 1–80 characters. |
| `plus_one_slots` | A whole number from 0 to 10. Repeated rows must use the same number. |

Names and labels may not contain line breaks or invisible control and formatting
characters. Those are refused rather than stripped: two rows that look identical
but hold different bytes would be a problem you could not see.

## Limits

| | Maximum |
| --- | --- |
| People in one event, named plus plus-one slots | 500 |
| Households in one event | 500 |
| Named guests in one household | 20 |
| Plus-one slots in one household | 10 |
| People in one household | 30 |

## How a guest finds their invitation

A guest types their full name. Candidary matches it exactly, after a fixed
normalization: Unicode NFKC, whitespace collapsed and trimmed, curly apostrophes
folded to `'`, dash variants folded to `-`, and lowercased.

Accents are **not** folded. `Jose` and `José` are different people, and treating
them as one would hand a stranger somebody else's invitation.

If a name matches more than one household, the guest is asked for a second name
from the same household, and Candidary intersects the two. So a shared name is
fine as long as some other name in that household narrows the pair down to one:

```csv
lee-a,Lee household,Alex Lee,0
lee-a,Lee household,Sam Lee,0
lee-b,Lee household,Alex Lee,0
lee-b,Lee household,Pat Lee,0
```

Both households contain an Alex Lee, and both are still reachable: asking for
Sam or Pat resolves it.

This file cannot be imported:

```csv
lee-a,Lee household,Alex Lee,0
lee-b,Lee household,Alex Lee,0
```

Two households whose only name is the same name cannot be told apart by anyone,
including us. Add a distinguishing name to one of them.

A name repeated inside a single household is refused too — each row is a
different person.

## Universal additive preview and commit

The manager workspace keeps the selected file or pasted text only in the active
browser draft. It maps or groups the source, turns every remaining ungrouped
name into a visible individual invitation, and sends only the normalized
candidate batch to the Worker.

Preview writes nothing. The Worker owns name normalization, household-key
generation, capacity, public-lookup reachability, target versions, and every
authoritative issue. Commit revalidates the exact canonical preview and applies
all creates and explicit appends in one transaction or none. A serialized batch
request may be at most **512 KiB**, separate from the **256 KiB** source-file
limit.

When no key is supplied for a new household, Candidary generates one and may
suffix that generated value to avoid a collision. A supplied or mapped key is
preserved exactly when valid and unused. It blocks when invalid or already held
by an active household, archived household, or another new household in the
same batch; it is never silently rewritten and never selects an existing
household. Appending requires the host to choose the committed household
explicitly.

Changing staged content after preview requires another preview and a new
idempotency key. Retrying an unchanged commit uses the same key, so a lost
response returns the original receipt rather than adding guests twice.

## Strict API preview, then commit

Uploading a file previews it. The preview reports how many households, named
guests, plus-one slots, and people the file would create, and lists every
problem with the line it is on. Line 1 is the header, so data starts at line 2.

Preview writes nothing. Every problem is blocking: a file with any problem
cannot be committed, and no counts are shown for it, because a partial number
beside a broken file reads as partial success.

Committing sends the same file back. Candidary re-reads it from scratch — the
preview is a courtesy, not evidence — and refuses the commit if the file
changed, if the guest list changed underneath it, if the event already has a
guest list, or if RSVP is already open. The whole roster lands in one
transaction or none of it does.

The strict compatibility import can only run on an event that has never had a
guest list. Archiving a household does not undo that: archived households are
kept. A file used through the manager workspace after setup is instead an
additive batch.

## What intake never does

- It never touches a response. A guest who has already answered keeps their
  answer unless the host explicitly supplies attendance for newly appended
  capacity in that responded household.
- It never removes, merges, or moves anyone. Those are not Add guests actions.
- It never picks an existing household from a matching label or key.

## Exports

The guest list exports as CSV from the event manager at any time, from
`GET /api/manage/events/:eventId/rsvp/export.csv`. It is served as
`text/csv; charset=utf-8` with
`Content-Disposition: attachment; filename="<slug>-rsvp-<YYYY-MM-DD>.csv"`, where
the filename date is today's calendar date **in the event's own time zone** — not
the server's and not the browser's.

The header is exactly:

```
household_key,household_label,household_archived_at,member_kind,member_name,attendance,member_order,household_version,first_responded_at,last_responded_at,last_actor,event_timezone
```

One row per named guest and per plus-one slot, including rows nobody has answered
yet and rows belonging to archived households, so the file always reconciles
against the invited capacity rather than against whoever happened to reply.

| Column | Meaning |
| --- | --- |
| `household_key` | The stable identifier, preserved exactly when supplied or generated by Candidary when omitted. |
| `household_label` | The household's current label. |
| `household_archived_at` | Empty for an active household; an ISO UTC timestamp for an archived one. |
| `member_kind` | `named` or `plus_one`. |
| `member_name` | The named guest, or the attending plus-one's name. Empty for a plus-one slot that is pending or declined. |
| `attendance` | `pending`, `attending`, or `declined`. |
| `member_order` | The household's own stable ordering, starting at 0. |
| `household_version` | The version this row was exported at. |
| `first_responded_at` | ISO UTC timestamp of the household's first response, or empty. |
| `last_responded_at` | ISO UTC timestamp of the most recent response, or empty. |
| `last_actor` | `household` or `host`, or empty if nobody has responded. |
| `event_timezone` | The event's IANA zone, so the timestamps above can be read locally. |

Every timestamp in the file is ISO 8601 in UTC. The event's zone is carried in its
own column rather than applied to the timestamps, so no reader has to guess which
convention a column follows.

Any cell whose first non-whitespace character is `=`, `+`, `-`, or `@` is written
with a leading apostrophe so a spreadsheet reads it as text rather than a formula.
Every other cell is exported unchanged, byte for byte. The same encoder is used
for the photo export's CSV and manifest.

Guest submission receipts and manager batch receipts are never exported. They
exist so a lost response can be safely retried, not as a revision history, and
they are not visible as roster data.
