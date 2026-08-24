/* Static healthcheck probe baked into the runtime image.
 *
 * The Java image ran `wget --spider` inside an alpine JRE base. A debian-slim runtime
 * has neither wget nor curl, and installing them via apt under buildx QEMU emulation is
 * exactly how arm64 builds die (exit 255 mid-unpack). So we ship a ~2 KB static-binary
 * probe instead: no shell, no packages, no libc in the runtime image at all.
 *
 * Mirrors the Java probe byte-for-byte in effect: GET {CONTEXT_PATH}/actuator/health
 * on localhost:{PORT}, exit 0 iff HTTP 200.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <netdb.h>
#include <unistd.h>

int main(void) {
    const char *port = getenv("PORT");
    if (!port || !*port) port = "8080";
    const char *ctx = getenv("CONTEXT_PATH");
    if (!ctx || !*ctx) ctx = "/tlhub";

    char path[512];
    snprintf(path, sizeof path, "%.200s/actuator/health", ctx);

    struct addrinfo hints = {0}, *res = NULL;
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    if (getaddrinfo("127.0.0.1", port, &hints, &res) != 0 || !res) return 1;

    int fd = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
    if (fd < 0) { freeaddrinfo(res); return 1; }
    if (connect(fd, res->ai_addr, res->ai_addrlen) != 0) {
        close(fd); freeaddrinfo(res); return 1;
    }
    freeaddrinfo(res);

    char req[640];
    int len = snprintf(req, sizeof req,
                       "GET %.200s HTTP/1.1\r\nHost: localhost\r\n"
                       "Connection: close\r\n\r\n", path);
    if (len <= 0 || write(fd, req, (size_t)len) != len) { close(fd); return 1; }

    char buf[1024];
    ssize_t n = read(fd, buf, sizeof buf - 1);
    close(fd);
    if (n <= 0) return 1;
    buf[n] = '\0';
    /* Status line looks like "HTTP/1.1 200 OK" — match the code, not the reason. */
    return strstr(buf, " 200 ") ? 0 : 1;
}
