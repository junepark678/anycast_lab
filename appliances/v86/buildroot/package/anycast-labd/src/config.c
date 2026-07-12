#define _GNU_SOURCE

#include "anycast-labd.h"

#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static void __attribute__((format(printf, 2, 3)))
set_error(struct labd_error *error, const char *format, ...)
{
	va_list arguments;

	if (error == NULL)
		return;
	va_start(arguments, format);
	vsnprintf(error->message, sizeof(error->message), format, arguments);
	va_end(arguments);
}

bool labd_canonical_positive(const char *value, unsigned long maximum,
			     unsigned long *parsed)
{
	char *end = NULL;
	unsigned long result;

	if (value == NULL || value[0] < '1' || value[0] > '9')
		return false;
	for (const unsigned char *cursor = (const unsigned char *)value;
	     *cursor != '\0'; cursor++) {
		if (!isdigit(*cursor))
			return false;
	}
	errno = 0;
	result = strtoul(value, &end, 10);
	if (errno != 0 || end == value || *end != '\0' || result > maximum)
		return false;
	if (parsed != NULL)
		*parsed = result;
	return true;
}

static int base64_value(unsigned char byte)
{
	if (byte >= 'A' && byte <= 'Z')
		return byte - 'A';
	if (byte >= 'a' && byte <= 'z')
		return byte - 'a' + 26;
	if (byte >= '0' && byte <= '9')
		return byte - '0' + 52;
	if (byte == '+')
		return 62;
	if (byte == '/')
		return 63;
	return -1;
}

int labd_base64_decode(const char *input, unsigned char **output,
			 size_t *output_length, size_t limit,
			 struct labd_error *error)
{
	size_t length;
	size_t padding = 0;
	size_t decoded_length;
	unsigned char *decoded;
	size_t destination = 0;

	if (input == NULL || output == NULL || output_length == NULL) {
		set_error(error, "invalid base64 decoder arguments");
		return -1;
	}
	length = strlen(input);
	if ((length & 3U) != 0U) {
		set_error(error, "base64 length is not canonical");
		return -1;
	}
	if (length != 0 && input[length - 1] == '=')
		padding++;
	if (length > 1 && input[length - 2] == '=')
		padding++;
	decoded_length = (length / 4U) * 3U - padding;
	if (decoded_length > limit) {
		set_error(error, "decoded base64 value exceeds %zu bytes", limit);
		return -1;
	}
	decoded = calloc(decoded_length + 1U, 1U);
	if (decoded == NULL) {
		set_error(error, "out of memory decoding base64");
		return -1;
	}

	for (size_t offset = 0; offset < length; offset += 4U) {
		int a = base64_value((unsigned char)input[offset]);
		int b = base64_value((unsigned char)input[offset + 1U]);
		int c = input[offset + 2U] == '=' ? 0 :
			base64_value((unsigned char)input[offset + 2U]);
		int d = input[offset + 3U] == '=' ? 0 :
			base64_value((unsigned char)input[offset + 3U]);
		uint32_t combined;
		bool final = offset + 4U == length;

		if (a < 0 || b < 0 || c < 0 || d < 0 ||
		    (!final && (input[offset + 2U] == '=' ||
			       input[offset + 3U] == '=')) ||
		    (input[offset + 2U] == '=' && input[offset + 3U] != '=')) {
			free(decoded);
			set_error(error, "invalid canonical base64 payload");
			return -1;
		}
		combined = ((uint32_t)a << 18U) | ((uint32_t)b << 12U) |
			((uint32_t)c << 6U) | (uint32_t)d;
		if (destination < decoded_length)
			decoded[destination++] = (unsigned char)(combined >> 16U);
		if (destination < decoded_length)
			decoded[destination++] = (unsigned char)(combined >> 8U);
		if (destination < decoded_length)
			decoded[destination++] = (unsigned char)combined;
	}
	if ((padding == 2U && length != 0U &&
	     (base64_value((unsigned char)input[length - 3U]) & 15) != 0) ||
	    (padding == 1U &&
	     (base64_value((unsigned char)input[length - 2U]) & 3) != 0)) {
		free(decoded);
		set_error(error, "invalid canonical base64 pad bits");
		return -1;
	}
	*output = decoded;
	*output_length = decoded_length;
	return 0;
}

char *labd_base64_encode(const unsigned char *input, size_t length)
{
	static const char alphabet[] =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	size_t encoded_length = ((length + 2U) / 3U) * 4U;
	char *encoded = malloc(encoded_length + 1U);
	size_t destination = 0;

	if (encoded == NULL)
		return NULL;
	for (size_t offset = 0; offset < length; offset += 3U) {
		uint32_t value = (uint32_t)input[offset] << 16U;
		bool second = offset + 1U < length;
		bool third = offset + 2U < length;

		if (second)
			value |= (uint32_t)input[offset + 1U] << 8U;
		if (third)
			value |= input[offset + 2U];
		encoded[destination++] = alphabet[(value >> 18U) & 63U];
		encoded[destination++] = alphabet[(value >> 12U) & 63U];
		encoded[destination++] = second ? alphabet[(value >> 6U) & 63U] : '=';
		encoded[destination++] = third ? alphabet[value & 63U] : '=';
	}
	encoded[destination] = '\0';
	return encoded;
}

static bool valid_utf8(const unsigned char *value, size_t length)
{
	size_t offset = 0;

	while (offset < length) {
		unsigned char first = value[offset++];
		unsigned int remaining;
		uint32_t scalar;
		uint32_t minimum;

		if (first == 0)
			return false;
		if (first < 0x80)
			continue;
		if ((first & 0xe0U) == 0xc0U) {
			remaining = 1;
			scalar = first & 0x1fU;
			minimum = 0x80U;
		} else if ((first & 0xf0U) == 0xe0U) {
			remaining = 2;
			scalar = first & 0x0fU;
			minimum = 0x800U;
		} else if ((first & 0xf8U) == 0xf0U) {
			remaining = 3;
			scalar = first & 0x07U;
			minimum = 0x10000U;
		} else {
			return false;
		}
		if (offset + remaining > length)
			return false;
		while (remaining-- > 0U) {
			unsigned char next = value[offset++];
			if ((next & 0xc0U) != 0x80U)
				return false;
			scalar = (scalar << 6U) | (next & 0x3fU);
		}
		if (scalar < minimum || scalar > 0x10ffffU ||
		    (scalar >= 0xd800U && scalar <= 0xdfffU))
			return false;
	}
	return true;
}

static char *decode_text(struct labd_node_config *config, const char *token,
			 size_t maximum, const char *label,
			 struct labd_error *error)
{
	unsigned char *value = NULL;
	size_t length = 0;

	/* A zero-length base64 value has no bytes and therefore cannot occupy a
	 * whitespace-delimited protocol field.  The bootstrap grammar reserves '-'
	 * (which is outside the RFC 4648 alphabet) as its sole empty-text token. */
	if (strcmp(token, "-") == 0) {
		value = calloc(1U, 1U);
		if (value == NULL) {
			set_error(error, "out of memory decoding %s", label);
			return NULL;
		}
	} else if (labd_base64_decode(token, &value, &length, maximum, error) < 0) {
		return NULL;
	}
	if (!valid_utf8(value, length)) {
		free(value);
		set_error(error, "%s is not valid non-NUL UTF-8", label);
		return NULL;
	}
	if (config->decoded_bytes + length + 1U > LABD_MAX_CONFIG_DECODED) {
		free(value);
		set_error(error, "decoded node configuration exceeds %u bytes",
			  LABD_MAX_CONFIG_DECODED);
		return NULL;
	}
	config->decoded_bytes += length + 1U;
	return (char *)value;
}

bool labd_path_is_normalized_absolute(const char *path)
{
	const char *component;

	if (path == NULL || path[0] != '/' || path[1] == '\0')
		return false;
	if (strlen(path) >= 4096U || strstr(path, "//") != NULL)
		return false;
	component = path + 1;
	while (*component != '\0') {
		const char *slash = strchr(component, '/');
		size_t length = slash == NULL ? strlen(component) :
			(size_t)(slash - component);

		if (length == 0U || (length == 1U && component[0] == '.') ||
		    (length == 2U && component[0] == '.' && component[1] == '.'))
			return false;
		component = slash == NULL ? component + length : slash + 1;
	}
	return path[strlen(path) - 1U] != '/';
}

bool labd_path_is_writable(const char *path)
{
	static const char *const roots[] = {
		"/etc/", "/home/", "/root/", "/run/", "/tmp/", "/var/",
	};

	if (!labd_path_is_normalized_absolute(path))
		return false;
	for (size_t index = 0; index < sizeof(roots) / sizeof(roots[0]); index++) {
		size_t length = strlen(roots[index]);
		if (strncmp(path, roots[index], length) == 0)
			return true;
		if (strlen(path) + 1U == length &&
		    strncmp(path, roots[index], length - 1U) == 0)
			return true;
	}
	return false;
}

bool labd_path_is_reserved(const char *path)
{
	static const char *const reserved[] = {
		"/run/anycastlab/start.sh",
		LABD_ENTRYPOINT_FAILURE_PATH,
		LABD_ENTRYPOINT_STATUS_PATH,
		LABD_ENTRYPOINT_START_OUTPUT_PATH,
		LABD_ENTRYPOINT_START_PIPE_PATH,
		LABD_ENTRYPOINT_START_DONE_PATH,
		LABD_ENTRYPOINT_START_DONE_TMP_PATH,
		LABD_ENTRYPOINT_START_PID_PATH,
		LABD_ENTRYPOINT_START_PID_TMP_PATH,
	};

	if (!labd_path_is_normalized_absolute(path))
		return false;
	for (size_t index = 0; index < sizeof(reserved) / sizeof(reserved[0]);
	     index++) {
		size_t length = strlen(reserved[index]);

		if (strcmp(path, reserved[index]) == 0 ||
		    (strncmp(path, reserved[index], length) == 0 &&
		     path[length] == '/'))
			return true;
	}
	return false;
}

static bool valid_hostname(const char *hostname)
{
	size_t length = strlen(hostname);

	if (length == 0U || length > 63U || hostname[0] == '-' ||
	    hostname[length - 1U] == '-')
		return false;
	for (size_t index = 0; index < length; index++) {
		unsigned char byte = (unsigned char)hostname[index];
		if (!(isalnum(byte) || byte == '-' || byte == '.'))
			return false;
	}
	return true;
}

static bool valid_environment_name(const char *name)
{
	if (!(name[0] == '_' || isalpha((unsigned char)name[0])))
		return false;
	if (strlen(name) > 127U)
		return false;
	for (const unsigned char *cursor = (const unsigned char *)name + 1;
	     *cursor != '\0'; cursor++) {
		if (!(*cursor == '_' || isalnum(*cursor)))
			return false;
	}
	return true;
}

static bool valid_interface_name(const char *name)
{
	size_t length = strlen(name);

	if (length == 0U || length >= 16U || strcmp(name, ".") == 0 ||
	    strcmp(name, "..") == 0 || strcmp(name, "lo") == 0)
		return false;
	for (size_t index = 0; index < length; index++) {
		unsigned char byte = (unsigned char)name[index];
		if (!(isalnum(byte) || byte == '_' || byte == '-' || byte == '.'))
			return false;
	}
	return true;
}

static bool parse_mac(const char *value, uint8_t output[6])
{
	if (strlen(value) != 17U)
		return false;
	for (size_t index = 0; index < 6U; index++) {
		char pair[3] = { value[index * 3U], value[index * 3U + 1U], '\0' };
		char *end = NULL;
		unsigned long byte;

		if (!isxdigit((unsigned char)pair[0]) ||
		    !isxdigit((unsigned char)pair[1]) ||
		    (index != 5U && value[index * 3U + 2U] != ':') ||
		    isupper((unsigned char)pair[0]) || isupper((unsigned char)pair[1]))
			return false;
		errno = 0;
		byte = strtoul(pair, &end, 16);
		if (errno != 0 || *end != '\0' || byte > 255U)
			return false;
		output[index] = (uint8_t)byte;
	}
	return (output[0] & 1U) == 0U;
}

static size_t tokenize(char *line, char **tokens, size_t maximum)
{
	size_t count = 0;
	char *cursor = line;

	if (*line == '\0')
		return 0;
	while (true) {
		char *space;

		if (count == maximum)
			return maximum + 1U;
		tokens[count++] = cursor;
		space = strchr(cursor, ' ');
		if (space == NULL)
			break;
		*space = '\0';
		cursor = space + 1;
	}
	return count;
}

static ssize_t find_interface(const struct labd_node_config *config,
			      const char *id)
{
	for (size_t index = 0; index < config->interface_count; index++) {
		if (strcmp(config->interfaces[index].id, id) == 0)
			return (ssize_t)index;
	}
	return -1;
}

static int parse_node_line(struct labd_node_config *config, char **tokens,
			   size_t count, unsigned int expected_slot,
			   struct labd_error *error)
{
	unsigned long slot;
	char *node_id;
	char *hostname;

	if (count != 5U || strcmp(tokens[0], "node") != 0 ||
	    !labd_canonical_positive(tokens[1], LABD_MAX_NODES, &slot) ||
	    slot != expected_slot) {
		set_error(error, "node directive does not match slot %u", expected_slot);
		return -1;
	}
	if (strcmp(tokens[2], "bird") == 0)
		config->kind = LABD_KIND_BIRD;
	else if (strcmp(tokens[2], "frr") == 0)
		config->kind = LABD_KIND_FRR;
	else if (strcmp(tokens[2], "client") == 0)
		config->kind = LABD_KIND_CLIENT;
	else {
		set_error(error, "unsupported node kind");
		return -1;
	}
	node_id = decode_text(config, tokens[3], 256U, "node id", error);
	hostname = decode_text(config, tokens[4], 63U, "hostname", error);
	if (node_id == NULL || hostname == NULL) {
		free(node_id);
		free(hostname);
		return -1;
	}
	if (node_id[0] == '\0' || !valid_hostname(hostname)) {
		free(node_id);
		free(hostname);
		set_error(error, "invalid node id or Linux hostname");
		return -1;
	}
	config->slot = expected_slot;
	config->node_id = node_id;
	memcpy(config->hostname, hostname, strlen(hostname) + 1U);
	free(hostname);
	return 0;
}

static int parse_entrypoint(struct labd_node_config *config, char **tokens,
			    size_t count, struct labd_error *error)
{
	char *entrypoint;

	if (count != 2U || strcmp(tokens[0], "entrypoint") != 0) {
		set_error(error, "missing canonical entrypoint directive");
		return -1;
	}
	entrypoint = decode_text(config, tokens[1], 4095U, "entrypoint", error);
	if (entrypoint == NULL)
		return -1;
	if (!labd_path_is_normalized_absolute(entrypoint)) {
		free(entrypoint);
		set_error(error, "entrypoint must be a normalized absolute path");
		return -1;
	}
	config->entrypoint = entrypoint;
	return 0;
}

static int parse_argument(struct labd_node_config *config, char **tokens,
			  size_t count, struct labd_error *error)
{
	char *argument;

	if (count != 2U || config->argc == LABD_MAX_ARGS) {
		set_error(error, "invalid or excessive arg directive");
		return -1;
	}
	argument = decode_text(config, tokens[1], 4096U, "argument", error);
	if (argument == NULL)
		return -1;
	config->argv[config->argc++] = argument;
	return 0;
}

static int parse_environment(struct labd_node_config *config, char **tokens,
			     size_t count, struct labd_error *error)
{
	char *value;

	if (count != 3U || config->env_count == LABD_MAX_ENV ||
	    !valid_environment_name(tokens[1])) {
		set_error(error, "invalid or excessive env directive");
		return -1;
	}
	for (size_t index = 0; index < config->env_count; index++) {
		if (strcmp(config->env[index].name, tokens[1]) == 0) {
			set_error(error, "duplicate environment variable");
			return -1;
		}
	}
	value = decode_text(config, tokens[2], 8192U, "environment value", error);
	if (value == NULL)
		return -1;
	config->env[config->env_count].name = strdup(tokens[1]);
	if (config->env[config->env_count].name == NULL) {
		free(value);
		set_error(error, "out of memory copying environment name");
		return -1;
	}
	config->env[config->env_count].value = value;
	config->env_count++;
	return 0;
}

static int parse_interface(struct labd_node_config *config, char **tokens,
			   size_t count, struct labd_error *error)
{
	struct labd_interface *interface;
	unsigned long vlan;
	unsigned long mtu;
	char *id;
	char *name;

	if (count != 7U || config->interface_count == LABD_MAX_INTERFACES ||
	    !labd_canonical_positive(tokens[1], 4094U, &vlan) || vlan < 100U ||
	    !labd_canonical_positive(tokens[5], 65531U, &mtu) || mtu < 576U ||
	    (strcmp(tokens[6], "up") != 0 && strcmp(tokens[6], "down") != 0)) {
		set_error(error, "invalid or excessive interface directive");
		return -1;
	}
	id = decode_text(config, tokens[2], 256U, "interface id", error);
	name = decode_text(config, tokens[3], 15U, "interface name", error);
	if (id == NULL || name == NULL) {
		free(id);
		free(name);
		return -1;
	}
	if (id[0] == '\0' || !valid_interface_name(name)) {
		free(id);
		free(name);
		set_error(error, "invalid interface id or name");
		return -1;
	}
	for (size_t index = 0; index < config->interface_count; index++) {
		const struct labd_interface *candidate = &config->interfaces[index];
		if (candidate->vlan == vlan || strcmp(candidate->id, id) == 0 ||
		    strcmp(candidate->name, name) == 0 ||
		    strcmp(candidate->mac_text, tokens[4]) == 0) {
			free(id);
			free(name);
			set_error(error, "duplicate interface identity");
			return -1;
		}
	}
	interface = &config->interfaces[config->interface_count];
	if (!parse_mac(tokens[4], interface->mac)) {
		free(id);
		free(name);
		set_error(error, "invalid canonical unicast MAC address");
		return -1;
	}
	interface->vlan = (unsigned int)vlan;
	interface->id = id;
	memcpy(interface->name, name, strlen(name) + 1U);
	free(name);
	memcpy(interface->mac_text, tokens[4], sizeof(interface->mac_text));
	interface->mtu = (unsigned int)mtu;
	interface->up = strcmp(tokens[6], "up") == 0;
	snprintf(interface->staging_name, sizeof(interface->staging_name),
		 "al%02ui%02zu", config->slot, config->interface_count);
	config->interface_count++;
	return 0;
}

static int parse_address(struct labd_node_config *config, char **tokens,
			 size_t count, struct labd_error *error)
{
	struct labd_address *address;
	unsigned char *id = NULL;
	size_t id_length = 0;
	ssize_t interface_index;
	unsigned long prefix;
	int family;
	unsigned char binary[sizeof(struct in6_addr)];

	if (count != 4U || config->address_count == LABD_MAX_ADDRESSES ||
	    labd_base64_decode(tokens[1], &id, &id_length, 256U, error) < 0 ||
	    !valid_utf8(id, id_length)) {
		free(id);
		set_error(error, "invalid or excessive address directive");
		return -1;
	}
	interface_index = find_interface(config, (char *)id);
	free(id);
	if (interface_index < 0) {
		set_error(error, "address references an unknown interface");
		return -1;
	}
	family = strchr(tokens[2], ':') == NULL ? AF_INET : AF_INET6;
	if (!labd_canonical_positive(tokens[3], family == AF_INET ? 32U : 128U,
				     &prefix) && strcmp(tokens[3], "0") != 0) {
		set_error(error, "invalid address prefix length");
		return -1;
	}
	if (strcmp(tokens[3], "0") == 0)
		prefix = 0;
	if (strlen(tokens[2]) >= sizeof(address->text) ||
	    inet_pton(family, tokens[2], binary) != 1) {
		set_error(error, "invalid IP address");
		return -1;
	}
	for (size_t index = 0; index < config->address_count; index++) {
		const struct labd_address *candidate = &config->addresses[index];
		if (candidate->interface_index == (size_t)interface_index &&
		    candidate->family == family && candidate->prefix == prefix &&
		    strcmp(candidate->text, tokens[2]) == 0) {
			set_error(error, "duplicate interface address");
			return -1;
		}
	}
	address = &config->addresses[config->address_count++];
	address->interface_index = (size_t)interface_index;
	address->family = family;
	memcpy(address->text, tokens[2], strlen(tokens[2]) + 1U);
	address->prefix = (unsigned int)prefix;
	return 0;
}

void labd_free_node_config(struct labd_node_config *config)
{
	if (config == NULL)
		return;
	free(config->node_id);
	free(config->entrypoint);
	for (size_t index = 0; index < config->argc; index++)
		free(config->argv[index]);
	for (size_t index = 0; index < config->env_count; index++) {
		free(config->env[index].name);
		free(config->env[index].value);
	}
	for (size_t index = 0; index < config->interface_count; index++)
		free(config->interfaces[index].id);
	memset(config, 0, sizeof(*config));
}

int labd_parse_node_file(const char *path, unsigned int expected_slot,
			 struct labd_node_config *config,
			 struct labd_error *error)
{
	int descriptor = -1;
	struct stat metadata;
	char *contents = NULL;
	ssize_t received;
	size_t offset = 0;
	unsigned int line_number = 0;
	int status = -1;
	enum { EXPECT_HEADER, EXPECT_NODE, EXPECT_ENTRYPOINT, BODY } phase = EXPECT_HEADER;
	bool interfaces_started = false;

	if (config == NULL || expected_slot == 0U || expected_slot > LABD_MAX_NODES) {
		set_error(error, "invalid node parser arguments");
		return -1;
	}
	memset(config, 0, sizeof(*config));
	descriptor = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
	if (descriptor < 0 || fstat(descriptor, &metadata) < 0 ||
	    !S_ISREG(metadata.st_mode) || metadata.st_size <= 0 ||
	    metadata.st_size > (off_t)LABD_MAX_CONFIG_BYTES) {
		set_error(error, "cannot open bounded regular node configuration: %s",
			  strerror(errno));
		goto cleanup;
	}
	contents = malloc((size_t)metadata.st_size + 1U);
	if (contents == NULL) {
		set_error(error, "out of memory reading node configuration");
		goto cleanup;
	}
	while (offset < (size_t)metadata.st_size) {
		received = read(descriptor, contents + offset,
				(size_t)metadata.st_size - offset);
		if (received < 0 && errno == EINTR)
			continue;
		if (received <= 0) {
			set_error(error, "short read from node configuration");
			goto cleanup;
		}
		offset += (size_t)received;
	}
	contents[offset] = '\0';
	if (contents[offset - 1U] != '\n' ||
	    memchr(contents, '\0', offset) != NULL ||
	    memchr(contents, '\r', offset) != NULL ||
	    memchr(contents, '\t', offset) != NULL) {
		set_error(error, "node configuration is not canonical LF-delimited text");
		goto cleanup;
	}

	for (char *line = contents; line < contents + offset;) {
		char *newline = strchr(line, '\n');
		char *tokens[8];
		size_t token_count;

		line_number++;
		*newline = '\0';
		if (line[0] == '\0' || line[0] == ' ' ||
		    strstr(line, "  ") != NULL || line[strlen(line) - 1U] == ' ') {
			set_error(error, "non-canonical whitespace on line %u", line_number);
			goto cleanup;
		}
		token_count = tokenize(line, tokens, sizeof(tokens) / sizeof(tokens[0]));
		if (token_count > sizeof(tokens) / sizeof(tokens[0])) {
			set_error(error, "too many fields on line %u", line_number);
			goto cleanup;
		}
		if (phase == EXPECT_HEADER) {
			if (token_count != 1U || strcmp(tokens[0], "ANYCASTLAB_NODE/1") != 0) {
				set_error(error, "invalid node configuration header");
				goto cleanup;
			}
			phase = EXPECT_NODE;
		} else if (phase == EXPECT_NODE) {
			if (parse_node_line(config, tokens, token_count, expected_slot, error) < 0)
				goto cleanup;
			phase = EXPECT_ENTRYPOINT;
		} else if (phase == EXPECT_ENTRYPOINT) {
			if (parse_entrypoint(config, tokens, token_count, error) < 0)
				goto cleanup;
			phase = BODY;
		} else if (strcmp(tokens[0], "arg") == 0) {
			if (interfaces_started || parse_argument(config, tokens, token_count, error) < 0)
				goto cleanup;
		} else if (strcmp(tokens[0], "env") == 0) {
			if (interfaces_started || parse_environment(config, tokens, token_count, error) < 0)
				goto cleanup;
		} else if (strcmp(tokens[0], "interface") == 0) {
			interfaces_started = true;
			if (parse_interface(config, tokens, token_count, error) < 0)
				goto cleanup;
		} else if (strcmp(tokens[0], "address") == 0) {
			interfaces_started = true;
			if (parse_address(config, tokens, token_count, error) < 0)
				goto cleanup;
		} else {
			set_error(error, "unknown directive on line %u", line_number);
			goto cleanup;
		}
		line = newline + 1;
	}
	if (phase != BODY) {
		set_error(error, "truncated node configuration");
		goto cleanup;
	}
	status = 0;

cleanup:
	if (descriptor >= 0)
		close(descriptor);
	free(contents);
	if (status < 0)
		labd_free_node_config(config);
	return status;
}
