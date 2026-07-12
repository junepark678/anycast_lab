#ifndef ANYCAST_LABD_H
#define ANYCAST_LABD_H

#include <stdbool.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>

#define LABD_PROTOCOL "ANYCASTLAB/2"
#define LABD_BOOTSTRAP_ROOT "/run/anycastlab/bootstrap"
#define LABD_RUNTIME_ROOT "/run/anycastlab/nodes"
#define LABD_BASE_ROOT "/run/anycastlab/base-root"
#define LABD_CGROUP_ROOT "/sys/fs/cgroup/anycastlab"
#define LABD_HOST_MOUNT "/run/anycast-host"
#define LABD_TRUNK_DEFAULT "labtrunk0"
#define LABD_BOOTSTRAP_ARCHIVE LABD_HOST_MOUNT "/anycastlab-shared-bootstrap.tar"
#define LABD_ENTRYPOINT_FAILURE_PATH "/run/anycastlab/entrypoint.failure"
#define LABD_ENTRYPOINT_STATUS_PATH "/run/anycastlab/frr-status.out"
#define LABD_ENTRYPOINT_START_OUTPUT_PATH "/run/anycastlab/frr-start.out"
#define LABD_ENTRYPOINT_START_PIPE_PATH "/run/anycastlab/frr-start.pipe"
#define LABD_ENTRYPOINT_START_DONE_PATH "/run/anycastlab/frr-start.done"
#define LABD_ENTRYPOINT_START_DONE_TMP_PATH "/run/anycastlab/frr-start.done.tmp"
#define LABD_ENTRYPOINT_START_PID_PATH "/run/anycastlab/frr-start.pid"
#define LABD_ENTRYPOINT_START_PID_TMP_PATH "/run/anycastlab/frr-start.pid.tmp"

#define LABD_MAX_NODES 64U
#define LABD_MAX_ARGS 64U
#define LABD_MAX_ENV 64U
#define LABD_MAX_INTERFACES 32U
#define LABD_MAX_ADDRESSES 128U
#define LABD_MAX_TERMINALS 32U
#define LABD_MAX_CONTROL_LINE (256U * 1024U)
#define LABD_MAX_TERMINAL_CHUNK (16U * 1024U)
#define LABD_MAX_CONFIG_BYTES (256U * 1024U)
#define LABD_MAX_CONFIG_DECODED (128U * 1024U)
#define LABD_MAX_FILE_BYTES (16U * 1024U * 1024U)
#define LABD_MAX_ARCHIVE_BYTES (16U * 1024U * 1024U)
#define LABD_MAX_PROTOCOL_OUTPUT_LINE (32U * 1024U)
#define LABD_CONTROL_OUTPUT_BYTES (256U * 1024U)
#define LABD_EVENT_DETAIL_BYTES 192U

typedef ssize_t (*labd_output_write_fn)(int descriptor, const void *data,
					size_t length, void *context);

struct labd_output_queue {
	unsigned char data[LABD_CONTROL_OUTPUT_BYTES];
	size_t head;
	size_t length;
};

enum labd_apply_disposition {
	LABD_APPLY_CURRENT_ROOT,
	LABD_APPLY_PREPARE_ROOT,
	LABD_APPLY_REJECT_TRANSITION,
};

enum labd_kind {
	LABD_KIND_BIRD,
	LABD_KIND_FRR,
	LABD_KIND_CLIENT,
};

struct labd_env {
	char *name;
	char *value;
};

struct labd_address {
	size_t interface_index;
	int family;
	char text[64];
	unsigned int prefix;
};

struct labd_interface {
	unsigned int vlan;
	char *id;
	char name[16];
	char staging_name[16];
	uint8_t mac[6];
	char mac_text[18];
	unsigned int mtu;
	bool up;
};

struct labd_node_config {
	unsigned int slot;
	enum labd_kind kind;
	char *node_id;
	char hostname[64];
	char *entrypoint;
	char *argv[LABD_MAX_ARGS];
	size_t argc;
	struct labd_env env[LABD_MAX_ENV];
	size_t env_count;
	struct labd_interface interfaces[LABD_MAX_INTERFACES];
	size_t interface_count;
	struct labd_address addresses[LABD_MAX_ADDRESSES];
	size_t address_count;
	size_t decoded_bytes;
};

struct labd_error {
	char message[256];
};

int labd_parse_node_file(const char *path, unsigned int expected_slot,
			 struct labd_node_config *config,
			 struct labd_error *error);
void labd_free_node_config(struct labd_node_config *config);

int labd_base64_decode(const char *input, unsigned char **output,
			 size_t *output_length, size_t limit,
			 struct labd_error *error);
char *labd_base64_encode(const unsigned char *input, size_t length);

bool labd_path_is_normalized_absolute(const char *path);
bool labd_path_is_writable(const char *path);
bool labd_path_is_reserved(const char *path);
bool labd_canonical_positive(const char *value, unsigned long maximum,
			     unsigned long *parsed);

bool labd_read_failure_detail(const char *path, char *output,
			      size_t output_size);

void labd_output_init(struct labd_output_queue *queue);
size_t labd_output_pending(const struct labd_output_queue *queue);
int labd_output_enqueue(struct labd_output_queue *queue, const void *data,
			size_t length);
int labd_output_vprintf(struct labd_output_queue *queue, const char *format,
			va_list arguments);
int labd_output_printf(struct labd_output_queue *queue, const char *format, ...)
	__attribute__((format(printf, 2, 3)));
int labd_output_flush(struct labd_output_queue *queue, int descriptor,
		      labd_output_write_fn writer, void *context);
enum labd_apply_disposition labd_apply_disposition(bool running, bool starting,
						   bool namespace_alive);

int labd_extract_ustar(const char *archive_path, int root_fd,
		       struct labd_error *error);
int labd_copy_tree(const char *source_path, int root_fd,
		   const char *destination_name, struct labd_error *error);

#endif
