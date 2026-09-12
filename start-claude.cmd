@echo off
setlocal
set "ANTHROPIC_AUTH_TOKEN="
set "ANTHROPIC_BASE_URL=http://127.0.0.1:3141"
set "ANTHROPIC_API_KEY=sk-ant-dummy"
claude %*
