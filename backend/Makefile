CC=gcc
CFLAGS=-std=c11 -Wall -Wextra -O2 -Iinclude
LDFLAGS=-lmicrohttpd -lsqlite3 -lcjson -lcrypto -lpthread

SRC=$(wildcard src/*.c)
BIN=realstate_api

all: $(BIN)

$(BIN): $(SRC)
	$(CC) $(CFLAGS) -o $@ $(SRC) $(LDFLAGS)

clean:
	rm -f $(BIN)

run: all
	./$(BIN)
