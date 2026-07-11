#include "anycast_host_abi.h"

#include <string.h>

#if defined(__wasm__)

#define ANYCAST_IMPORT(module_name, symbol_name)                               \
  __attribute__((import_module(module_name), import_name(symbol_name)))

extern uint64_t anycast_import_now_ns(void)
    ANYCAST_IMPORT("anycast_host_v1", "now_ns");
extern int32_t anycast_import_fill_random(uint8_t *target, uint32_t length)
    ANYCAST_IMPORT("anycast_host_v1", "fill_random");
extern int32_t anycast_import_transmit_frame(uint32_t interface_index,
                                             const uint8_t *frame,
                                             uint32_t length)
    ANYCAST_IMPORT("anycast_host_v1", "transmit_frame");
extern void anycast_import_log(uint32_t level, const uint8_t *message,
                               uint32_t length)
    ANYCAST_IMPORT("anycast_host_v1", "log");

#else

static struct anycast_host_v1 bound_host;
static int host_is_bound;

#endif

uint32_t
anycast_appliance_host_abi_version(void)
{
  return ANYCAST_HOST_ABI_VERSION;
}

uint32_t
anycast_appliance_runtime_api_version(void)
{
  return ANYCAST_RUNTIME_API_VERSION;
}

int32_t
anycast_host_bind(const struct anycast_host_v1 *host)
{
#if defined(__wasm__)
  (void) host;
  return ANYCAST_ERR_INVALID_ARGUMENT;
#else
  const size_t required_size = sizeof(struct anycast_host_v1);
  if (!host || (host->abi_version != ANYCAST_HOST_ABI_VERSION) ||
      (host->struct_size < required_size) || !host->now_ns ||
      !host->fill_random || !host->transmit_frame || !host->log)
    return ANYCAST_ERR_INVALID_ARGUMENT;

  memcpy(&bound_host, host, required_size);
  host_is_bound = 1;
  return ANYCAST_OK;
#endif
}

uint64_t
anycast_host_now_ns(void)
{
#if defined(__wasm__)
  return anycast_import_now_ns();
#else
  return host_is_bound ? bound_host.now_ns(bound_host.context) : 0;
#endif
}

int32_t
anycast_host_fill_random(uint8_t *target, uint32_t length)
{
  if (!target && length)
    return ANYCAST_ERR_INVALID_ARGUMENT;
#if defined(__wasm__)
  return anycast_import_fill_random(target, length);
#else
  if (!host_is_bound)
    return ANYCAST_ERR_HOST_UNBOUND;
  return bound_host.fill_random(bound_host.context, target, length);
#endif
}

int32_t
anycast_host_transmit_frame(uint32_t interface_index, const uint8_t *frame,
                            uint32_t length)
{
  if (!frame && length)
    return ANYCAST_ERR_INVALID_ARGUMENT;
#if defined(__wasm__)
  return anycast_import_transmit_frame(interface_index, frame, length);
#else
  if (!host_is_bound)
    return ANYCAST_ERR_HOST_UNBOUND;
  return bound_host.transmit_frame(bound_host.context, interface_index, frame,
                                   length);
#endif
}

void
anycast_host_log(uint32_t level, const uint8_t *message, uint32_t length)
{
  if (!message && length)
    return;
#if defined(__wasm__)
  anycast_import_log(level, message, length);
#else
  if (host_is_bound)
    bound_host.log(bound_host.context, level, message, length);
#endif
}
