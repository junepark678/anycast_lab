#include "anycast_host_abi.h"

#include <stdint.h>
#include <string.h>

int32_t
anycast_feasibility_probe(void)
{
  uint8_t entropy[8] = { 0 };
  const uint8_t frame[] = { 0x02, 0x00, 0x00, 0x00, 0x00, 0x02,
                            0x02, 0x00, 0x00, 0x00, 0x00, 0x01,
                            0x08, 0x00 };
  const uint8_t message[] = "anycast host ABI v1 probe";

  if (anycast_appliance_host_abi_version() != ANYCAST_HOST_ABI_VERSION)
    return 10;
  if (anycast_appliance_runtime_api_version() != ANYCAST_RUNTIME_API_VERSION)
    return 11;
  if (anycast_host_now_ns() == 0)
    return 12;
  if (anycast_host_fill_random(entropy, sizeof(entropy)) != ANYCAST_OK)
    return 13;
  if (anycast_host_transmit_frame(7, frame, sizeof(frame)) != ANYCAST_OK)
    return 14;

  anycast_host_log(ANYCAST_LOG_INFO, message, sizeof(message) - 1);
  return 0;
}

#if defined(ANYCAST_NATIVE_HARNESS)

#include <assert.h>
#include <stdio.h>

struct harness_state {
  unsigned random_calls;
  unsigned frame_calls;
  unsigned log_calls;
};

static uint64_t
harness_now_ns(void *context)
{
  (void) context;
  return UINT64_C(42000000);
}

static int32_t
harness_fill_random(void *context, uint8_t *target, uint32_t length)
{
  struct harness_state *state = context;
  uint32_t i;
  state->random_calls++;
  for (i = 0; i < length; i++)
    target[i] = (uint8_t) (i + 1);
  return ANYCAST_OK;
}

static int32_t
harness_transmit_frame(void *context, uint32_t interface_index,
                       const uint8_t *frame, uint32_t length)
{
  struct harness_state *state = context;
  state->frame_calls++;
  assert(interface_index == 7);
  assert(frame != NULL);
  assert(length == 14);
  return ANYCAST_OK;
}

static void
harness_log(void *context, uint32_t level, const uint8_t *message,
            uint32_t length)
{
  struct harness_state *state = context;
  state->log_calls++;
  assert(level == ANYCAST_LOG_INFO);
  assert(length == strlen("anycast host ABI v1 probe"));
  assert(memcmp(message, "anycast host ABI v1 probe", length) == 0);
}

int
main(void)
{
  struct harness_state state = { 0 };
  const struct anycast_host_v1 host = {
    .struct_size = sizeof(struct anycast_host_v1),
    .abi_version = ANYCAST_HOST_ABI_VERSION,
    .context = &state,
    .now_ns = harness_now_ns,
    .fill_random = harness_fill_random,
    .transmit_frame = harness_transmit_frame,
    .log = harness_log,
  };

  assert(anycast_host_bind(&host) == ANYCAST_OK);
  assert(anycast_feasibility_probe() == 0);
  assert(state.random_calls == 1);
  assert(state.frame_calls == 1);
  assert(state.log_calls == 1);
  puts("anycast host ABI v1 native feasibility probe: ok");
  return 0;
}

#endif
