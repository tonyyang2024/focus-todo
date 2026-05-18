---
name: file-compression
description: Compress and decompress files in various formats (tar.gz, zip, gz). Use when user asks to compress files, extract archives, or reduce file sizes.
---

# File Compression Skill

## When to use
- User asks to compress files or folders
- User asks to extract/decompress archives
- User wants to create tarballs, zip files, or gzip archives

## Available tools
- `tar` — create/extract .tar, .tar.gz archives
- `gzip` — compress single files (.gz)
- `unzip` — extract .zip archives

## Commands

### Compress a folder (tar.gz)
```bash
tar -czf output.tar.gz folder/
```

### Compress a single file (gzip)
```bash
gzip -k filename
```

### Extract tar.gz
```bash
tar -xzf archive.tar.gz
```

### Extract zip
```bash
unzip archive.zip -d destination/
```

### Show archive contents without extracting
```bash
tar -tzf archive.tar.gz
unzip -l archive.zip
```

### Create zip (cross-platform, using Node.js)
```bash
node -e "
const { execSync } = require('child_process');
const dir = process.argv[1];
execSync('powershell Compress-Archive -Path ' + dir + ' -DestinationPath ' + dir + '.zip');
" folder/
```

## Important
- Always show file sizes before and after compression
- Use `ls -lh` to display sizes
- When zip creation fails (no `zip` binary), use PowerShell `Compress-Archive` on Windows
