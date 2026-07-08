# Meridion AI — project notes for Claude Code

## Standing rule: Microsoft Clarity on every page

Meridion AI's own Microsoft Clarity analytics snippet (project ID `xj1vynd82i`) must be
present in the `<head>` of **every** HTML page in this site — no exceptions, and this
applies to any new page added in future development (new marketing pages, new portal
sections, new standalone tools, etc.), not just the four that exist today.

When creating a new `.html` file, insert this exact snippet into its `<head>`, right
before `</head>`:

```html
<script type="text/javascript">
    (function(c,l,a,r,i,t,y){
        c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
        t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
        y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
    })(window, document, "clarity", "script", "xj1vynd82i");
</script>
```

Currently installed in: `index.html`, `login.html`, `portal.html`, `rep.html`.

Before finishing any task that adds a new page or a copy of an existing page, verify with:

```
grep -L "clarity.ms/tag" *.html
```

This should print **no files**. If it prints a file, that page is missing the snippet —
add it before considering the task done.

**Do not confuse this with** the mocked "Visitors · Microsoft Clarity" panel inside
`portal.html` (client portal) — that's an unrelated, still-demo *future* product concept
(per-client website tracking sold to Meridion AI's own clients about their own sites). It
has its own commented placeholder note near the bottom of portal.html's inline script and
should stay untouched/demo-only unless separately instructed.
