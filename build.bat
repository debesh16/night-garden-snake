@echo off
rem Rebuilds web\wasm\snake.js + snake.wasm from the C core with Emscripten.
rem Run "emsdk_env.bat" from your emsdk folder first so emcc is on PATH.
rem The web\ folder already contains a committed build; hosting never needs this.

cd /d "%~dp0"
where emcc >nul 2>nul || (echo emcc not found. Run emsdk_env.bat first. & exit /b 1)

call emcc -O2 -Wall -Wextra -std=c99 -Icore ^
  core\snake_core.c core\rng.c core\board.c core\level.c core\replay.c ^
  core\modes\perks.c core\modes\rewind.c core\modes\daily.c ^
  -sMODULARIZE=1 -sEXPORT_NAME=createSnake ^
  -sENVIRONMENT=web -sFILESYSTEM=0 ^
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP32 ^
  -o web\wasm\snake.js
if errorlevel 1 exit /b 1
echo Built web\wasm\snake.js and web\wasm\snake.wasm
