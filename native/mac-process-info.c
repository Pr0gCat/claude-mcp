#include <libproc.h>
#include <sys/proc_info.h>
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  char *end;
  errno = 0;
  long pid = strtol(argv[1], &end, 10);
  if (errno || *end || pid <= 0 || pid > INT_MAX) return 2;
  struct proc_bsdinfo info;
  int size = proc_pidinfo((int)pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
  if (size != sizeof(info)) {
    puts(size == 0 && errno == ESRCH ? "missing" : "unknown");
    return 0;
  }
  time_t seconds = (time_t)info.pbi_start_tvsec;
  struct tm utc;
  char date[32];
  if (!gmtime_r(&seconds, &utc) || !strftime(date, sizeof(date), "%Y-%m-%dT%H:%M:%S", &utc)) return 1;
  printf("%s.%06lluZ\n", date, (unsigned long long)info.pbi_start_tvusec);
  return 0;
}
