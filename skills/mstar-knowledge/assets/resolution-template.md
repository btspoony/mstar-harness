# Resolution templates for mstar-knowledge

## Bug track template

```markdown
<!-- frontmatter fields: see references/schema.yaml (bug track adds symptoms/root_cause/resolution_type) -->

# <Title>

## Problem
<1-2 sentence description of the issue>

## Symptoms
- <Observable symptom 1>
- <Observable symptom 2>

## What Didn't Work
- <Failed approach 1>: <why it failed>
- <Failed approach 2>: <why it failed>

## Solution
<The actual fix with code examples when applicable>

```lang
// Before
<broken code>

// After
<fixed code>
```

## Why This Works
<Root cause explanation and why the solution addresses it>

## Prevention
- <Strategy 1 to avoid recurrence>
- <Strategy 2>
- <Test case or lint rule if applicable>
```

## Knowledge track template

```markdown
<!-- frontmatter fields: see references/schema.yaml (knowledge track optional applies_when) -->

# <Title>

## Context
<What situation, gap, or friction prompted this guidance>

## Guidance
<The practice, pattern, or recommendation>

```lang
// Example of the pattern
<code>
```

## Why This Matters
<Rationale and impact of following or not following this guidance>

## When to Apply
- <Condition or situation 1>
- <Condition or situation 2>

## Examples
### Before
```lang
<code before>
```

### After
```lang
<code after>
```
```
