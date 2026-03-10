# Prism Project Instructions

## Context Hub (chub) Integration

This project has `chub` (Context Hub) installed globally. Use it to fetch accurate, curated API documentation instead of relying on memory when working with external libraries/services.

### When to use `chub`:
- When writing code that integrates with external APIs or SDKs (e.g., Cloudflare Workers, AWS, authentication services)
- When unsure about the correct API usage, method signatures, or best practices for a library
- When the user asks to integrate a new third-party service
- When encountering API-related errors that might stem from outdated knowledge

### How to use:
```bash
chub search <query>        # Find relevant docs
chub get <id> --lang js    # Fetch JS-specific docs (use js for this project)
chub annotate <id> "note"  # Save learnings for future sessions
```

### When NOT to use:
- For standard HTML/CSS/JS that doesn't involve external APIs
- For project-internal code (app.js, journal.js, _worker.js)
- When you're already confident about the API from recent context
