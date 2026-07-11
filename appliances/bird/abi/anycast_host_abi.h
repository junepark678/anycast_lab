#ifndef ANYCAST_HOST_ABI_H
#define ANYCAST_HOST_ABI_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define ANYCAST_HOST_ABI_VERSION 1u
#define ANYCAST_RUNTIME_API_VERSION 1u

enum anycast_status {
  ANYCAST_OK = 0,
  ANYCAST_ERR_INVALID_ARGUMENT = -1,
  ANYCAST_ERR_HOST_UNBOUND = -2,
  ANYCAST_ERR_HOST_FAILURE = -3
};

enum anycast_log_level {
  ANYCAST_LOG_DEBUG = 0,
  ANYCAST_LOG_INFO = 1,
  ANYCAST_LOG_WARNING = 2,
  ANYCAST_LOG_ERROR = 3
};

/* Native harness callbacks mirror the WebAssembly imports below. */
struct anycast_host_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  void *context;
  uint64_t (*now_ns)(void *context);
  int32_t (*fill_random)(void *context, uint8_t *target, uint32_t length);
  int32_t (*transmit_frame)(void *context, uint32_t interface_index,
                            const uint8_t *frame, uint32_t length);
  void (*log)(void *context, uint32_t level, const uint8_t *message,
              uint32_t length);
};

uint32_t anycast_appliance_host_abi_version(void);
uint32_t anycast_appliance_runtime_api_version(void);

/* Used by native tests. WebAssembly builds bind through module imports. */
int32_t anycast_host_bind(const struct anycast_host_v1 *host);

uint64_t anycast_host_now_ns(void);
int32_t anycast_host_fill_random(uint8_t *target, uint32_t length);
int32_t anycast_host_transmit_frame(uint32_t interface_index,
                                    const uint8_t *frame, uint32_t length);
void anycast_host_log(uint32_t level, const uint8_t *message, uint32_t length);

/* Minimal probe export. This validates wiring only; it is not a BIRD entrypoint. */
int32_t anycast_feasibility_probe(void);

#ifdef __cplusplus
}
#endif

#endif
