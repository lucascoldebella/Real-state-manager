CC=gcc
CFLAGS=-std=c11 -Wall -Wextra -Werror -O2 -Iinclude -fstack-protector-strong -D_FORTIFY_SOURCE=2 -fPIE
LDFLAGS=-lmicrohttpd -lsqlite3 -lcjson -lcrypto -lpthread
LDFLAGS_EXTRA=-pie -Wl,-z,relro,-z,now

SRC=$(wildcard src/*.c)
BIN=realstate_api

all: $(BIN)

$(BIN): $(SRC)
	$(CC) $(CFLAGS) -o $@ $(SRC) $(LDFLAGS) $(LDFLAGS_EXTRA)

clean:
	rm -f $(BIN)

run: all
	./$(BIN)
