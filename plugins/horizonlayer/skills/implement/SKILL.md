---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
---

Implement the work described by the user in the spec or tickets.

## HorizonLayer ticket loop

When the work comes from a HorizonLayer Issue, load the Issue and its relevant parent, comments, dependencies, and linked Knowledge Pages before editing. If it is a `wayfinder:map` or `wayfinder:<type>` Issue, return to Wayfinder: it is a decision ticket, not a build ticket.

Claim the implementation Issue with `issues` `issue.claim` and its latest revision before the first code change. Use `knowledge` to retrieve durable specifications, decisions, and research; keep the Issue body focused on the promised behavior and acceptance criteria.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, reload the Issue and linked Knowledge context, check every acceptance criterion and out-of-scope item against the final diff and verification evidence, then use /code-review to review the work.

Record a concise resolution comment, update the Issue to its explicit terminal status with the latest revision, and store lasting implementation knowledge as a linked Knowledge Page when it will help a later session. Return to `issues` `issue.query` for the next ready ticket in a fresh implementation session.

Commit your work to the current branch.
