#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <conio.h>
#include <windows.h>
#include <time.h>
#include "core/snake_core.h"

/* The rules (movement, collisions, fruit, score, speed) now live in core/,
   the same C code the web version runs as WebAssembly. This file only draws
   the board in the console and reads the keyboard.

   Build: see the "console" target in the Makefile (gcc, snake.c plus the
   core/ sources). */

/* Play-field size, measured in CELLS (not characters). */
#define WIDTH  SC_STD_W
#define HEIGHT SC_STD_H

/* Every cell is drawn 2 characters wide. A console character is about twice
   as tall as it is wide, so a 2-character cell is (roughly) square.
   This is what makes horizontal and vertical speed look the same. */
#define CELL_W 2

/* Screen layout: the wall is one cell (2 chars) thick on every side. */
#define BOARD_LEFT  CELL_W                           /* first column inside */
#define BOARD_TOP   1                                /* first row inside    */
#define SCREEN_W    ((WIDTH + 2) * CELL_W)           /* total border width  */
#define INFO_ROW    (HEIGHT + 3)                     /* row for score text  */

static int32_t *view;                   /* the core's state, see snake_core.h */
static char shown[WIDTH * HEIGHT];      /* what is on screen in each cell     */
int highScore = 0;
int gameOver, won;

// Move cursor to position
void gotoxy(int x, int y) {
    COORD coord;
    coord.X = (SHORT)x;
    coord.Y = (SHORT)y;
    SetConsoleCursorPosition(GetStdHandle(STD_OUTPUT_HANDLE), coord);
}

// Hide cursor
void hideCursor() {
    HANDLE h = GetStdHandle(STD_OUTPUT_HANDLE);
    CONSOLE_CURSOR_INFO cursorInfo;
    cursorInfo.dwSize = 100;
    cursorInfo.bVisible = FALSE;
    SetConsoleCursorInfo(h, &cursorInfo);
}

// Draw a 2-character string at a board cell
void drawCell(int cx, int cy, const char *s) {
    gotoxy(BOARD_LEFT + cx * CELL_W, BOARD_TOP + cy);
    printf("%s", s);
}

// Only redraw the cells that changed since the last step.
void Redraw() {
    char want[WIDTH * HEIGHT];
    memset(want, ' ', sizeof want);
    for (int i = 0; i < view[V_FOOD_N]; i++)
        want[view[V_FOOD + i * 2]] = 'F';
    for (int i = view[V_LEN0] - 1; i >= 0; i--)
        want[view[V_SNAKE0 + i]] = i ? 'B' : 'H';

    for (int c = 0; c < WIDTH * HEIGHT; c++) {
        if (want[c] == shown[c]) continue;
        const char *s = want[c] == 'H' ? "()" : want[c] == 'B' ? "[]" : want[c] == 'F' ? "<>" : "  ";
        drawCell(c % WIDTH, c / WIDTH, s);
        shown[c] = want[c];
    }
}

// Draw the whole border once. Every row is exactly SCREEN_W characters wide,
// so the top, bottom, left and right walls all line up.
void DrawBorder() {
    gotoxy(0, 0);
    for (int i = 0; i < SCREEN_W; i++)
        printf("#");
    printf("\n");

    for (int i = 0; i < HEIGHT; i++) {
        printf("##");
        for (int j = 0; j < WIDTH; j++)
            printf("  ");
        printf("##\n");
    }

    for (int i = 0; i < SCREEN_W; i++)
        printf("#");
    printf("\n");
}

void DrawInfo() {
    gotoxy(0, INFO_ROW);
    printf("Score: %-5d  High score: %-5d  Fruits: %-4d", view[V_SCORE0], highScore, view[V_FRUITS]);
    gotoxy(0, INFO_ROW + 1);
    printf("Move: WASD / arrow keys   P: pause   X: quit");
}

void Setup() {
    system("cls");
    hideCursor();

    gameOver = 0;
    won = 0;

    /* Classic rules, plain walled board, seeded from the clock. The core
       starts a 3-segment snake in the middle, facing right. */
    game_new(MODE_CLASSIC, SHAPE_SQUARE, (int)time(NULL), 0);
    view = game_state_ptr();
    memset(shown, ' ', sizeof shown);

    DrawBorder();
    Redraw();
    DrawInfo();
}

/* The core keeps the 2-step direction queue and ignores reversing. */
void queueDirection(int d) {
    game_input(0, d);
}

void togglePause() {
    gotoxy(0, INFO_ROW + 2);
    printf("PAUSED - press P to continue");
    while (1) {
        int c = _getch();
        if (c == 'p' || c == 'P') break;
        if (c == 'x' || c == 'X') { gameOver = 1; break; }
    }
    gotoxy(0, INFO_ROW + 2);
    printf("                            ");
}

void Input() {
    while (_kbhit()) {
        int c = _getch();
        if (c == 0 || c == 224) {          /* arrow keys send 2 codes */
            switch (_getch()) {
            case 72: queueDirection(DIR_UP);    break;
            case 80: queueDirection(DIR_DOWN);  break;
            case 75: queueDirection(DIR_LEFT);  break;
            case 77: queueDirection(DIR_RIGHT); break;
            }
            continue;
        }
        switch (c) {
        case 'a': case 'A': queueDirection(DIR_LEFT);  break;
        case 'd': case 'D': queueDirection(DIR_RIGHT); break;
        case 'w': case 'W': queueDirection(DIR_UP);    break;
        case 's': case 'S': queueDirection(DIR_DOWN);  break;
        case 'p': case 'P': togglePause();             break;
        case 'x': case 'X': gameOver = 1;              break;
        }
    }
}

void Logic() {
    int ev = game_step();
    Redraw();

    if (ev & EV_ATE) {
        if (view[V_SCORE0] > highScore)
            highScore = view[V_SCORE0];
        DrawInfo();
    }
    if (view[V_STATUS] == ST_OVER) {
        gameOver = 1;
        won = view[V_WON];
    }
}

int currentDelay() {
    return view[V_DELAY];    /* 200 ms, 5 ms faster per fruit, never below 60 */
}

int main() {
    SetConsoleTitle("Snake");

    while (1) {
        Setup();

        while (!gameOver) {
            /* Fixed time step: poll input until the step time is up, so the
               speed does not depend on how long drawing took. */
            DWORD next = GetTickCount() + currentDelay();
            while (!gameOver && GetTickCount() < next) {
                Input();
                Sleep(5);
            }
            if (!gameOver)
                Logic();
            fflush(stdout);
        }

        gotoxy(0, INFO_ROW + 2);
        printf(won ? "YOU WIN! The board is full!" : "GAME OVER!");
        printf("  Final score: %d\n", view[V_SCORE0]);
        printf("Press R to play again or Q to quit.");

        Sleep(500);                       // ignore keys pressed while dying
        while (_kbhit()) _getch();        // flush them

        int c;
        do {
            c = _getch();
        } while (c != 'r' && c != 'R' && c != 'q' && c != 'Q');

        if (c == 'q' || c == 'Q')
            break;
    }

    gotoxy(0, INFO_ROW + 4);
    return 0;
}
