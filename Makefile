# Rebuilds web/wasm/snake.js + snake.wasm from the C core.
# Needs Emscripten on PATH (run emsdk_env first). The web/ folder already
# contains a committed build, so hosting never needs this.

CORE_SRC = core/snake_core.c core/rng.c core/board.c core/level.c core/replay.c \
           core/modes/perks.c core/modes/rewind.c core/modes/daily.c

EMFLAGS = -O2 -Wall -Wextra -std=c99 -Icore \
          -sMODULARIZE=1 -sEXPORT_NAME=createSnake \
          -sENVIRONMENT=web -sFILESYSTEM=0 \
          -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP32

web/wasm/snake.js: $(CORE_SRC) core/snake_core.h core/internal.h
	emcc $(EMFLAGS) $(CORE_SRC) -o web/wasm/snake.js

wasm: web/wasm/snake.js

# Native checks with gcc (optional)
test:
	gcc -std=c99 -Wall -Wextra -O2 -Icore tests/test_core.c $(CORE_SRC) -o test_core
	./test_core

console:
	gcc -std=gnu99 -Wall -Wextra -O2 -Icore snake.c $(CORE_SRC) -o snake_console

clean:
	rm -f test_core test_core.exe snake_console snake_console.exe

.PHONY: wasm test console clean
