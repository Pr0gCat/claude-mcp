#include <libproc.h>
#include <sys/proc_info.h>
#include <errno.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static int parse_pid(const char *value, int *pid) {
  char *end;
  errno = 0;
  long parsed = strtol(value, &end, 10);
  if (errno || *end || parsed <= 0 || parsed > INT_MAX) return 0;
  *pid = (int)parsed;
  return 1;
}

static int started_at(int pid, char *output, size_t capacity) {
  struct proc_bsdinfo info;
  int size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
  if (size != sizeof(info)) return size == 0 && errno == ESRCH ? 0 : -1;
  time_t seconds = (time_t)info.pbi_start_tvsec;
  struct tm utc;
  char date[32];
  if (!gmtime_r(&seconds, &utc) || !strftime(date, sizeof(date), "%Y-%m-%dT%H:%M:%S", &utc)) return -1;
  int written = snprintf(output, capacity, "%s.%06lluZ", date,
    (unsigned long long)info.pbi_start_tvusec);
  return written > 0 && (size_t)written < capacity ? 1 : -1;
}

static int identity_status(int pid, const char *expected) {
  char observed[48];
  int status = started_at(pid, observed, sizeof(observed));
  if (status != 1) return status;
  return strcmp(observed, expected) == 0 ? 1 : 0;
}

static int watch_parent(int parent_pid, const char *parent_started,
                        int child_pid, const char *child_started) {
  for (;;) {
    int child_status = identity_status(child_pid, child_started);
    if (child_status == 0) return 0;
    if (child_status < 0) {
      usleep(100000);
      continue;
    }
    int parent_status = identity_status(parent_pid, parent_started);
    if (parent_status == 0) {
      if (identity_status(child_pid, child_started) == 1) kill(-child_pid, SIGKILL);
      return 0;
    }
    usleep(100000);
  }
}

int main(int argc, char **argv) {
  if (argc == 6 && strcmp(argv[1], "--watch-parent") == 0) {
    int parent_pid;
    int child_pid;
    if (!parse_pid(argv[2], &parent_pid) || !parse_pid(argv[4], &child_pid)) return 2;
    return watch_parent(parent_pid, argv[3], child_pid, argv[5]);
  }
  if (argc != 2) return 2;
  int pid;
  if (!parse_pid(argv[1], &pid)) return 2;
  char observed[48];
  int status = started_at(pid, observed, sizeof(observed));
  if (status != 1) {
    puts(status == 0 ? "missing" : "unknown");
    return 0;
  }
  puts(observed);
  return 0;
}
