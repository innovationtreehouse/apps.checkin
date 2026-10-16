# Income: cutover to QuickBooks Classes on items

Steps that expire once #2180 ships.

1. Ship the additive migration: the Class id column on item assignments, and the
   bucket column made optional.
2. For every existing assignment, copy its bucket's QuickBooks Class id onto it.
   An assignment whose bucket has no Class, or is archived, gets no Class id and
   no decision: remove it, so the item shows as undecided and finance picks its
   Class. List those items for finance before removing them.
3. Ship the code that books by the item's Class.
4. A later release drops the bucket column once nothing reads it.
5. Apply the rule change in `2180_INCOME_LESS_INTERVENTION.md` to the register,
   then delete both files.
