const DEFAULT_COMPACTION_PROMPT = `You are compacting your own session to free context space. You will continue this session after compaction with this summary as your starting context.

Include what YOU will need to effectively resume your work:
- Current task and progress
- Files being worked on
- Key decisions made and why
- Next steps to take
- Important context that would be hard to rediscover
- Any active debug sessions, in-progress edits, or partial implementations

Be concise but preserve enough detail that you can continue seamlessly.
You are summarizing for yourself, not another agent.

When constructing the summary, try to stick to this template:
---
## Goal

[What goal(s) are you trying to accomplish?]

## Instructions

- [What important instructions are relevant to your current work]
- [If there is a plan or spec, include key details so you can continue using it]

## Discoveries

[What notable things were learned that would be useful to remember when continuing]

## Accomplished

[What work has been completed, what work is still in progress, and what work is left?]

## Relevant files / directories

[Construct a structured list of relevant files that have been read, edited, or created that pertain to the task at hand. If all the files in a directory are relevant, include the path to the directory.]

## Notes

[Anything else you need to remember — patterns observed, gotchas, tool quirks, environment details]
---`;

export const getCompactionPrompt = (): string => DEFAULT_COMPACTION_PROMPT;