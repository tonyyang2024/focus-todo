# Voice Code for Windows - VS Code Claude Code Voice Pipeline
# Equivalent to: Type4Me + Auto-Submit + voice-dialog MCP on macOS

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " Voice Code for Windows Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if running as admin for certain features
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Host "[1/4] Checking Windows Speech Recognition..." -ForegroundColor Yellow

# Load System.Speech for TTS (built into Windows)
try {
    Add-Type -AssemblyName System.Speech
    $tts = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $voices = $tts.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }
    Write-Host "  TTS: Available ($($voices.Count) voices)" -ForegroundColor Green
    Write-Host "  Voices: $($voices -join ', ')" -ForegroundColor Gray
} catch {
    Write-Host "  TTS: Not available" -ForegroundColor Red
}

Write-Host ""
Write-Host "[2/4] Windows Dictation (Win+H)" -ForegroundColor Yellow
Write-Host "  Press Win+H in any text field to start dictation" -ForegroundColor White
Write-Host "  Works in VS Code, browser, any input field" -ForegroundColor White
Write-Host "  No software install required" -ForegroundColor Green

Write-Host ""
Write-Host "[3/4] Voice AI Panel (Skill Copilot)" -ForegroundColor Yellow
Write-Host "  Open: http://localhost:3000/skill-copilot/" -ForegroundColor White
Write-Host "  Features: Voice input, TTS readback, 13 AI skills, auto-submit" -ForegroundColor White
Write-Host "  Mobile: https://focus-todo-0svl.onrender.com/skill-copilot/" -ForegroundColor White

Write-Host ""
Write-Host "[4/4] VS Code Integration" -ForegroundColor Yellow
Write-Host "  Method 1: Open Skill Copilot in VS Code Simple Browser (Ctrl+Shift+P -> Simple Browser)" -ForegroundColor White
Write-Host "  Method 2: Use Windows Dictation (Win+H) directly in Claude Code input" -ForegroundColor White
Write-Host "  Method 3: Use split terminal - Skill Copilot left, Claude Code right" -ForegroundColor White

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host " Quick Start" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Voice to Text:  Win+H (Windows built-in, works everywhere)" -ForegroundColor White
Write-Host "  Text to Speech: Skill Copilot TTS button (reads AI replies)" -ForegroundColor White
Write-Host "  Full Voice AI:  http://localhost:3000/skill-copilot/" -ForegroundColor White
Write-Host "  Phone Access:   https://focus-todo-0svl.onrender.com/skill-copilot/" -ForegroundColor White
Write-Host ""

# --- Speak test message ---
try {
    $tts = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $tts.SelectVoice('Microsoft Huihui Desktop')
    $tts.Speak('Voice Code for Windows setup complete.')
} catch {}
