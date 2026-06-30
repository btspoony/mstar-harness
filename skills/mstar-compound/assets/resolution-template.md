# Resolution templates for mstar-compound

## Bug track template

```markdown
---
module: <area>
date: YYYY-MM-DD
problem_type: <enum>
category: <directory>
severity: <critical|high|medium|low>
symptoms: ["<symptom 1>", "<symptom 2>"]
root_cause: <fundamental cause>
resolution_type: <enum>
tags: [<keyword1>, <keyword2>]
---

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
---
module: <area>
date: YYYY-MM-DD
problem_type: <enum>
category: <directory>
severity: <critical|high|medium|low>
applies_when: ["<condition 1>", "<condition 2>"]
tags: [<keyword1>, <keyword2>]
---

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
