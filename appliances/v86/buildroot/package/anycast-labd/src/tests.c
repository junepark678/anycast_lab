#define _GNU_SOURCE

#include "anycast-labd.h"

#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

static void write_all_or_abort(int descriptor, const void *data, size_t length)
{
	const unsigned char *bytes = data;
	size_t offset = 0;

	while (offset < length) {
		ssize_t written = write(descriptor, bytes + offset, length - offset);
		assert(written > 0);
		offset += (size_t)written;
	}
}

static void write_file(const char *path, const char *contents)
{
	int descriptor = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
	assert(descriptor >= 0);
	write_all_or_abort(descriptor, contents, strlen(contents));
	assert(close(descriptor) == 0);
}

static void octal_field(unsigned char *field, size_t length, uint64_t value)
{
	char buffer[32];
	assert(snprintf(buffer, sizeof(buffer), "%0*llo", (int)length - 1,
			(unsigned long long)value) == (int)length - 1);
	memcpy(field, buffer, length - 1U);
	field[length - 1U] = 0;
}

static void create_archive(const char *path, const char *entry,
			   char type, mode_t mode, const unsigned char *payload,
			   size_t payload_length)
{
	unsigned char header[512] = { 0 };
	unsigned char zero[1024] = { 0 };
	unsigned char padding[512] = { 0 };
	uint64_t checksum = 0;
	int descriptor;

	assert(strlen(entry) <= 100U);
	memcpy(header, entry, strlen(entry));
	octal_field(header + 100U, 8U, mode);
	octal_field(header + 108U, 8U, 0U);
	octal_field(header + 116U, 8U, 0U);
	octal_field(header + 124U, 12U, payload_length);
	octal_field(header + 136U, 12U, 0U);
	memset(header + 148U, ' ', 8U);
	header[156U] = (unsigned char)type;
	memcpy(header + 257U, "ustar\0", 6U);
	memcpy(header + 263U, "00", 2U);
	for (size_t index = 0; index < sizeof(header); index++)
		checksum += header[index];
	char checksum_text[7];
	assert(snprintf(checksum_text, sizeof(checksum_text), "%06llo",
			(unsigned long long)checksum) == 6);
	memcpy(header + 148U, checksum_text, 6U);
	header[154U] = 0;
	header[155U] = ' ';
	descriptor = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
	assert(descriptor >= 0);
	write_all_or_abort(descriptor, header, sizeof(header));
	if (payload_length > 0U) {
		write_all_or_abort(descriptor, payload, payload_length);
		size_t remainder = (512U - (payload_length & 511U)) & 511U;
		write_all_or_abort(descriptor, padding, remainder);
	}
	write_all_or_abort(descriptor, zero, sizeof(zero));
	assert(close(descriptor) == 0);
}

static void test_base64(void)
{
	struct labd_error error = { { 0 } };
	unsigned char *decoded = NULL;
	size_t length = 0;
	char *encoded;
	static const unsigned char binary[] = { 0U, 1U, 254U, 255U };

	assert(labd_base64_decode("Zg==", &decoded, &length, 8U, &error) == 0);
	assert(length == 1U && decoded[0] == 'f');
	free(decoded);
	decoded = NULL;
	assert(labd_base64_decode("Zh==", &decoded, &length, 8U, &error) < 0);
	assert(labd_base64_decode("Zg=", &decoded, &length, 8U, &error) < 0);
	assert(labd_base64_decode("Zg==", &decoded, &length, 0U, &error) < 0);
	encoded = labd_base64_encode(binary, sizeof(binary));
	assert(encoded != NULL && strcmp(encoded, "AAH+/w==") == 0);
	free(encoded);
}

struct writer_step {
	ssize_t result;
	int error;
};

struct fault_writer {
	const struct writer_step *steps;
	size_t step_count;
	size_t step_index;
	unsigned char *output;
	size_t output_capacity;
	size_t output_length;
};

static ssize_t fault_write(int descriptor, const void *data, size_t length,
			   void *opaque)
{
	struct fault_writer *writer = opaque;
	ssize_t result = (ssize_t)length;

	(void)descriptor;
	if (writer->step_index < writer->step_count) {
		const struct writer_step *step = &writer->steps[writer->step_index++];

		result = step->result;
		if (result < 0) {
			errno = step->error;
			return -1;
		}
	}
	if (result > (ssize_t)length)
		return result;
	assert(writer->output_length + (size_t)result <= writer->output_capacity);
	memcpy(writer->output + writer->output_length, data, (size_t)result);
	writer->output_length += (size_t)result;
	return result;
}

static void test_output_queue(void)
{
	struct labd_output_queue *queue = malloc(sizeof(*queue));
	unsigned char *captured = malloc(LABD_CONTROL_OUTPUT_BYTES + 64U);
	unsigned char *large = malloc(LABD_CONTROL_OUTPUT_BYTES);
	const char line[] = LABD_PROTOCOL " OK 7 partial-write-safe\n";
	const struct writer_step first_steps[] = {
		{ 2, 0 },
		{ -1, EAGAIN },
	};
	const struct writer_step second_steps[] = {
		{ -1, EINTR },
		{ 3, 0 },
	};
	struct fault_writer writer = {
		.steps = first_steps,
		.step_count = sizeof(first_steps) / sizeof(first_steps[0]),
		.output = captured,
		.output_capacity = LABD_CONTROL_OUTPUT_BYTES + 64U,
	};

	assert(queue != NULL && captured != NULL && large != NULL);
	labd_output_init(queue);
	assert(labd_output_printf(queue, "%s", line) == 0);
	assert(labd_output_pending(queue) == sizeof(line) - 1U);
	assert(labd_output_flush(queue, 123, fault_write, &writer) == 0);
	assert(writer.output_length == 2U);
	assert(labd_output_pending(queue) == sizeof(line) - 3U);
	writer.steps = second_steps;
	writer.step_count = sizeof(second_steps) / sizeof(second_steps[0]);
	writer.step_index = 0U;
	assert(labd_output_flush(queue, 123, fault_write, &writer) == 0);
	assert(labd_output_pending(queue) == 0U);
	assert(writer.output_length == sizeof(line) - 1U);
	assert(memcmp(captured, line, sizeof(line) - 1U) == 0);

	/* Leave the ring head near its end, then append across the boundary. */
	labd_output_init(queue);
	memset(large, 'A', LABD_CONTROL_OUTPUT_BYTES - 8U);
	assert(labd_output_enqueue(queue, large,
				   LABD_CONTROL_OUTPUT_BYTES - 8U) == 0);
	const struct writer_step wrap_steps[] = {
		{ (ssize_t)LABD_CONTROL_OUTPUT_BYTES - 16, 0 },
		{ -1, EAGAIN },
	};
	writer.steps = wrap_steps;
	writer.step_count = sizeof(wrap_steps) / sizeof(wrap_steps[0]);
	writer.step_index = 0U;
	writer.output_length = 0U;
	assert(labd_output_flush(queue, 123, fault_write, &writer) == 0);
	assert(labd_output_pending(queue) == 8U);
	assert(labd_output_enqueue(queue, "0123456789abcdef", 16U) == 0);
	writer.steps = NULL;
	writer.step_count = 0U;
	writer.step_index = 0U;
	writer.output_length = 0U;
	assert(labd_output_flush(queue, 123, fault_write, &writer) == 0);
	assert(writer.output_length == 24U);
	assert(memcmp(captured, "AAAAAAAA0123456789abcdef", 24U) == 0);

	/* Capacity failure is atomic: it never puts a partial protocol line on wire. */
	labd_output_init(queue);
	memset(large, 'Q', LABD_CONTROL_OUTPUT_BYTES);
	assert(labd_output_enqueue(queue, large, LABD_CONTROL_OUTPUT_BYTES) == 0);
	errno = 0;
	assert(labd_output_enqueue(queue, "x", 1U) < 0 && errno == ENOBUFS);
	assert(labd_output_pending(queue) == LABD_CONTROL_OUTPUT_BYTES);

	char *oversized = malloc(LABD_MAX_PROTOCOL_OUTPUT_LINE + 2U);
	assert(oversized != NULL);
	memset(oversized, 'Z', LABD_MAX_PROTOCOL_OUTPUT_LINE + 1U);
	oversized[LABD_MAX_PROTOCOL_OUTPUT_LINE + 1U] = '\0';
	labd_output_init(queue);
	errno = 0;
	assert(labd_output_printf(queue, "%s", oversized) < 0 && errno == EMSGSIZE);
	assert(labd_output_pending(queue) == 0U);
	free(oversized);
	free(large);
	free(captured);
	free(queue);
}

static void test_apply_disposition(void)
{
	assert(labd_apply_disposition(true, false, true) ==
	       LABD_APPLY_CURRENT_ROOT);
	assert(labd_apply_disposition(false, false, false) ==
	       LABD_APPLY_PREPARE_ROOT);
	assert(labd_apply_disposition(false, true, true) ==
	       LABD_APPLY_REJECT_TRANSITION);
	assert(labd_apply_disposition(false, false, true) ==
	       LABD_APPLY_REJECT_TRANSITION);
}

static void test_paths(void)
{
	assert(labd_path_is_normalized_absolute("/etc/bird/bird.conf"));
	assert(!labd_path_is_normalized_absolute("etc/bird.conf"));
	assert(!labd_path_is_normalized_absolute("/etc/../shadow"));
	assert(!labd_path_is_normalized_absolute("/etc//bird.conf"));
	assert(labd_path_is_writable("/run/anycastlab/config"));
	assert(labd_path_is_writable("/etc"));
	assert(!labd_path_is_writable("/usr/bin/bird"));
	assert(labd_path_is_reserved("/run/anycastlab/start.sh"));
	assert(labd_path_is_reserved(LABD_ENTRYPOINT_FAILURE_PATH));
	assert(labd_path_is_reserved("/run/anycastlab/entrypoint.failure/nested"));
	assert(labd_path_is_reserved(LABD_ENTRYPOINT_START_OUTPUT_PATH));
	assert(labd_path_is_reserved(LABD_ENTRYPOINT_START_PIPE_PATH));
	assert(labd_path_is_reserved(LABD_ENTRYPOINT_START_DONE_PATH));
	assert(labd_path_is_reserved(LABD_ENTRYPOINT_START_DONE_TMP_PATH));
	assert(labd_path_is_reserved(LABD_ENTRYPOINT_START_PID_PATH));
	assert(labd_path_is_reserved(LABD_ENTRYPOINT_START_PID_TMP_PATH));
	assert(!labd_path_is_reserved("/run/anycastlab/entrypoint.failure.tmp"));
}

static void test_failure_detail(const char *directory)
{
	char path[PATH_MAX];
	char detail[LABD_EVENT_DETAIL_BYTES];
	char oversized[LABD_EVENT_DETAIL_BYTES];
	static const char noisy[] =
		" \tFRR\nreadiness\001\177\377 failed  status 1\r\n";

	snprintf(path, sizeof(path), "%s/failure", directory);
	write_file(path, noisy);
	assert(labd_read_failure_detail(path, detail, sizeof(detail)));
	assert(strcmp(detail, "FRR readiness failed status 1") == 0);

	write_file(path, "\n\t\001");
	assert(!labd_read_failure_detail(path, detail, sizeof(detail)));
	memset(oversized, 'x', sizeof(oversized));
	int descriptor = open(path, O_WRONLY | O_TRUNC);
	assert(descriptor >= 0);
	write_all_or_abort(descriptor, oversized, sizeof(oversized));
	assert(close(descriptor) == 0);
	assert(labd_read_failure_detail(path, detail, sizeof(detail)));
	assert(strlen(detail) == sizeof(detail) - 1U);

	write_file(path, "writable marker");
	assert(chmod(path, 0620) == 0);
	assert(!labd_read_failure_detail(path, detail, sizeof(detail)));
	assert(unlink(path) == 0);
	assert(symlink("failure-target", path) == 0);
	assert(!labd_read_failure_detail(path, detail, sizeof(detail)));
	assert(unlink(path) == 0);
}

static void test_node_config(const char *directory)
{
	char path[PATH_MAX];
	struct labd_node_config config;
	struct labd_error error = { { 0 } };
	const char valid[] =
		"ANYCASTLAB_NODE/1\n"
		"node 1 bird bm9kZS0x cm91dGVyLTE=\n"
		"entrypoint L3Vzci9zYmluL2JpcmQ=\n"
		"arg -\n"
		"env EMPTY -\n"
		"interface 100 aWYw ZXRoMA== 02:00:00:00:00:01 1500 up\n"
		"address aWYw 192.0.2.1 24\n"
		"address aWYw 2001:db8::1 64\n";

	snprintf(path, sizeof(path), "%s/node.conf", directory);
	write_file(path, valid);
	assert(labd_parse_node_file(path, 1U, &config, &error) == 0);
	assert(config.kind == LABD_KIND_BIRD);
	assert(strcmp(config.node_id, "node-1") == 0);
	assert(strcmp(config.hostname, "router-1") == 0);
	assert(strcmp(config.entrypoint, "/usr/sbin/bird") == 0);
	assert(config.argc == 1U && strcmp(config.argv[0], "") == 0);
	assert(config.env_count == 1U && strcmp(config.env[0].value, "") == 0);
	assert(config.interface_count == 1U && config.interfaces[0].vlan == 100U);
	assert(config.address_count == 2U);
	labd_free_node_config(&config);

	write_file(path,
		   "ANYCASTLAB_NODE/1\n"
		   "node 1 bird bm9kZQ== cm91dGVy\n"
		   "entrypoint L2Jpbi9zaA==\n"
		   "arg  \n");
	assert(labd_parse_node_file(path, 1U, &config, &error) < 0);

	write_file(path,
		   "ANYCASTLAB_NODE/1\n"
		   "node 1 bird bm9kZQ== cm91dGVy\n"
		   "entrypoint Ly4uL2Jpbi9zaA==\n");
	assert(labd_parse_node_file(path, 1U, &config, &error) < 0);

	write_file(path,
		   "ANYCASTLAB_NODE/1\n"
		   "node 1 bird bm9kZQ== cm91dGVy\n"
		   "entrypoint L2Jpbi9zaA==\n"
		   "interface 100 aWYw ZXRoMA== 03:00:00:00:00:01 1500 up\n");
	assert(labd_parse_node_file(path, 1U, &config, &error) < 0);
}

static void test_archive(const char *directory)
{
	char archive[PATH_MAX];
	char root[PATH_MAX];
	char outside[PATH_MAX];
	char escape[PATH_MAX];
	char escaped_file[PATH_MAX];
	char output[PATH_MAX + 32U];
	struct labd_error error = { { 0 } };
	static const unsigned char payload[] = "router id 192.0.2.1;\n";
	int root_fd;
	int descriptor;
	char contents[64] = { 0 };

	snprintf(archive, sizeof(archive), "%s/root.tar", directory);
	snprintf(root, sizeof(root), "%s/root", directory);
	assert(mkdir(root, 0700) == 0);
	root_fd = open(root, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
	assert(root_fd >= 0);
	create_archive(archive, "etc/bird/bird.conf", '0', 0640,
		       payload, sizeof(payload) - 1U);
	assert(labd_extract_ustar(archive, root_fd, &error) == 0);
	snprintf(output, sizeof(output), "%s/etc/bird/bird.conf", root);
	descriptor = open(output, O_RDONLY);
	assert(descriptor >= 0);
	assert(read(descriptor, contents, sizeof(contents)) ==
	       (ssize_t)(sizeof(payload) - 1U));
	assert(memcmp(contents, payload, sizeof(payload) - 1U) == 0);
	close(descriptor);

	create_archive(archive, "etc/../shadow", '0', 0600, payload, 1U);
	assert(labd_extract_ustar(archive, root_fd, &error) < 0);
	create_archive(archive, "etc/link", '2', 0777, payload, 1U);
	assert(labd_extract_ustar(archive, root_fd, &error) < 0);
	create_archive(archive, "usr/bin/replaced", '0', 0755, payload, 1U);
	assert(labd_extract_ustar(archive, root_fd, &error) < 0);
	create_archive(archive, "run/anycastlab/entrypoint.failure", '0', 0600,
		       payload, 1U);
	assert(labd_extract_ustar(archive, root_fd, &error) < 0);
	create_archive(archive, "run/anycastlab/entrypoint.failure/nested", '0',
		       0600, payload, 1U);
	assert(labd_extract_ustar(archive, root_fd, &error) < 0);
	create_archive(archive, "run/anycastlab/frr-status.out", '0', 0600,
		       payload, 1U);
	assert(labd_extract_ustar(archive, root_fd, &error) < 0);
	create_archive(archive, "run/anycastlab/frr-start.out", '0', 0600,
		       payload, 1U);
	assert(labd_extract_ustar(archive, root_fd, &error) < 0);
	create_archive(archive, "run/anycastlab/frr-start.pipe", '0', 0600,
		       payload, 1U);
	assert(labd_extract_ustar(archive, root_fd, &error) < 0);
	create_archive(archive, "run/anycastlab/frr-start.done", '0', 0600,
		       payload, 1U);
	assert(labd_extract_ustar(archive, root_fd, &error) < 0);
	create_archive(archive, "run/anycastlab/frr-start.done.tmp", '0', 0600,
		       payload, 1U);
	assert(labd_extract_ustar(archive, root_fd, &error) < 0);
	create_archive(archive, "run/anycastlab/frr-start.pid", '0', 0600,
		       payload, 1U);
	assert(labd_extract_ustar(archive, root_fd, &error) < 0);
	create_archive(archive, "run/anycastlab/frr-start.pid.tmp", '0', 0600,
		       payload, 1U);
	assert(labd_extract_ustar(archive, root_fd, &error) < 0);

	assert(strlen(directory) + strlen("/outside") + 1U <= sizeof(outside));
	assert(strlen(root) + strlen("/escape") + 1U <= sizeof(escape));
	memcpy(outside, directory, strlen(directory) + 1U);
	strcat(outside, "/outside");
	memcpy(escape, root, strlen(root) + 1U);
	strcat(escape, "/escape");
	assert(strlen(outside) + strlen("/owned") + 1U <= sizeof(escaped_file));
	memcpy(escaped_file, outside, strlen(outside) + 1U);
	strcat(escaped_file, "/owned");
	assert(mkdir(outside, 0700) == 0);
	assert(symlink(outside, escape) == 0);
	create_archive(archive, "escape/owned", '0', 0600, payload, 1U);
	assert(labd_extract_ustar(archive, root_fd, &error) < 0);
	assert(access(escaped_file, F_OK) < 0 && errno == ENOENT);
	close(root_fd);
}

int main(void)
{
	char directory[] = "/tmp/anycast-labd-tests.XXXXXX";
	char command[PATH_MAX + 32U];

	assert(mkdtemp(directory) != NULL);
	test_base64();
	test_output_queue();
	test_apply_disposition();
	test_paths();
	test_failure_detail(directory);
	test_node_config(directory);
	test_archive(directory);
	assert(snprintf(command, sizeof(command), "rm -rf -- '%s'", directory) > 0);
	assert(system(command) == 0);
	puts("anycast-labd unit tests passed");
	return 0;
}
