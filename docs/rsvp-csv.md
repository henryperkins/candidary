# The RSVP guest list file

Candidary imports a guest list once, from a CSV you prepare. After that import,
every change is an explicit edit in the event manager — there is no second
import and no synchronization. This page is the exact contract that file has to
meet.

## The file

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
| `household_key` | Your own stable identifier. Lowercase letters, digits, `-`, and `_`; must start with a letter or digit; 1–64 characters. It is never shown to guests. |
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

## Preview, then commit

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

The first import can only run on an event that has never had a guest list.
Archiving a household does not undo that: archived households are kept.

## What import never does

- It never touches a response. A guest who has already answered keeps their
  answer through every later edit.
- It never removes anyone. Removing a named guest is a manual edit, and is only
  possible before that household's first response.
- It never runs twice.

## Exports

The guest list exports as CSV from the event manager at any time. Any cell whose
first non-whitespace character is `=`, `+`, `-`, or `@` is written with a leading
apostrophe so a spreadsheet reads it as text rather than a formula. Every other
cell is exported unchanged.
