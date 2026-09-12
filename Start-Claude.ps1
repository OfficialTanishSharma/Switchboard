Remove-Item Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue
$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:3141'
$env:ANTHROPIC_API_KEY = 'sk-ant-dummy'
claude @args
