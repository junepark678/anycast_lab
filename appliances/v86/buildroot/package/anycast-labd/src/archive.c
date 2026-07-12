#define _GNU_SOURCE

#include "anycast-labd.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#define TAR_BLOCK 512U
#define TAR_MAX_ENTRIES 1024U

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

static bool all_zero(const unsigned char *value, size_t length)
{
	for (size_t index = 0; index < length; index++) {
		if (value[index] != 0U)
			return false;
	}
	return true;
}

static int read_field(const unsigned char *header, size_t offset, size_t length,
		      char *output, size_t output_size)
{
	size_t field_length = 0;

	while (field_length < length && header[offset + field_length] != 0U)
		field_length++;
	if (field_length + 1U > output_size)
		return -1;
	memcpy(output, header + offset, field_length);
	output[field_length] = '\0';
	return 0;
}

static int parse_octal(const unsigned char *header, size_t offset, size_t length,
		       uint64_t maximum, uint64_t *output)
{
	uint64_t value = 0;
	bool digit_seen = false;

	for (size_t index = 0; index < length; index++) {
		unsigned char byte = header[offset + index];

		if (byte == 0U || byte == ' ') {
			for (size_t tail = index; tail < length; tail++) {
				if (header[offset + tail] != 0U &&
				    header[offset + tail] != ' ')
					return -1;
			}
			break;
		}
		if (byte < '0' || byte > '7')
			return -1;
		digit_seen = true;
		if (value > (maximum - (uint64_t)(byte - '0')) / 8U)
			return -1;
		value = value * 8U + (uint64_t)(byte - '0');
	}
	if (!digit_seen)
		value = 0;
	*output = value;
	return 0;
}

static bool valid_relative_archive_path(const char *path, bool directory)
{
	char absolute[PATH_MAX];
	size_t length = strlen(path);

	if (length == 0U || path[0] == '/' || length + 2U > sizeof(absolute))
		return false;
	if (directory && path[length - 1U] == '/')
		length--;
	if (length == 0U)
		return false;
	snprintf(absolute, sizeof(absolute), "/%.*s", (int)length, path);
	return labd_path_is_writable(absolute) &&
		!labd_path_is_reserved(absolute);
}

static int open_parent(int root_fd, const char *relative_path, bool create,
		       char *basename, size_t basename_size,
		       struct labd_error *error)
{
	char path[PATH_MAX];
	char *cursor;
	int current = dup(root_fd);

	if (current < 0 || strlen(relative_path) >= sizeof(path)) {
		if (current >= 0)
			close(current);
		set_error(error, "archive path is too long");
		return -1;
	}
	memcpy(path, relative_path, strlen(relative_path) + 1U);
	while (path[0] != '\0' && path[strlen(path) - 1U] == '/')
		path[strlen(path) - 1U] = '\0';
	cursor = path;
	while (true) {
		char *slash = strchr(cursor, '/');
		int next;

		if (slash == NULL) {
			if (strlen(cursor) + 1U > basename_size) {
				set_error(error, "archive basename is too long");
				close(current);
				return -1;
			}
			memcpy(basename, cursor, strlen(cursor) + 1U);
			return current;
		}
		*slash = '\0';
		if (create && mkdirat(current, cursor, 0755) < 0 && errno != EEXIST) {
			set_error(error, "cannot create archive directory: %s", strerror(errno));
			close(current);
			return -1;
		}
		next = openat(current, cursor,
			      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
		if (next < 0) {
			set_error(error, "unsafe archive parent component: %s", strerror(errno));
			close(current);
			return -1;
		}
		close(current);
		current = next;
		cursor = slash + 1;
	}
}

static int ensure_directory(int root_fd, const char *path, mode_t mode,
			    struct labd_error *error)
{
	char basename[NAME_MAX + 1U];
	int parent = open_parent(root_fd, path, true, basename, sizeof(basename), error);
	int descriptor;

	if (parent < 0)
		return -1;
	if (mkdirat(parent, basename, mode & 0777U) < 0 && errno != EEXIST) {
		set_error(error, "cannot create archive directory: %s", strerror(errno));
		close(parent);
		return -1;
	}
	descriptor = openat(parent, basename,
			    O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
	close(parent);
	if (descriptor < 0) {
		set_error(error, "archive directory collides with a non-directory");
		return -1;
	}
	if (fchmod(descriptor, mode & 0777U) < 0) {
		set_error(error, "cannot apply archive directory mode: %s", strerror(errno));
		close(descriptor);
		return -1;
	}
	close(descriptor);
	return 0;
}

static int write_regular(int root_fd, const char *path, mode_t mode,
			 const unsigned char *data, size_t length,
			 struct labd_error *error)
{
	char basename[NAME_MAX + 1U];
	int parent = open_parent(root_fd, path, true, basename, sizeof(basename), error);
	int descriptor;
	struct stat metadata;
	size_t offset = 0;

	if (parent < 0)
		return -1;
	descriptor = openat(parent, basename,
			    O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC | O_NOFOLLOW,
			    mode & 0777U);
	close(parent);
	if (descriptor < 0 || fstat(descriptor, &metadata) < 0 ||
	    !S_ISREG(metadata.st_mode)) {
		set_error(error, "unsafe archive output file: %s", strerror(errno));
		if (descriptor >= 0)
			close(descriptor);
		return -1;
	}
	if (fchmod(descriptor, mode & 0777U) < 0) {
		set_error(error, "cannot apply archive file mode: %s", strerror(errno));
		close(descriptor);
		return -1;
	}
	while (offset < length) {
		ssize_t written = write(descriptor, data + offset, length - offset);

		if (written < 0 && errno == EINTR)
			continue;
		if (written <= 0) {
			set_error(error, "short write extracting archive");
			close(descriptor);
			return -1;
		}
		offset += (size_t)written;
	}
	if (fsync(descriptor) < 0) {
		set_error(error, "cannot sync extracted file: %s", strerror(errno));
		close(descriptor);
		return -1;
	}
	close(descriptor);
	return 0;
}

int labd_extract_ustar(const char *archive_path, int root_fd,
		       struct labd_error *error)
{
	int descriptor = -1;
	struct stat metadata;
	unsigned char *archive = NULL;
	size_t archive_length;
	size_t offset = 0;
	size_t entries = 0;
	size_t total_payload = 0;
	unsigned int zero_blocks = 0;
	int status = -1;

	descriptor = open(archive_path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
	if (descriptor < 0 || fstat(descriptor, &metadata) < 0 ||
	    !S_ISREG(metadata.st_mode) || metadata.st_size < (off_t)(TAR_BLOCK * 2U) ||
	    metadata.st_size > (off_t)LABD_MAX_ARCHIVE_BYTES ||
	    (metadata.st_size % TAR_BLOCK) != 0) {
		set_error(error, "root archive is not a bounded regular ustar file");
		goto cleanup;
	}
	archive_length = (size_t)metadata.st_size;
	archive = malloc(archive_length);
	if (archive == NULL) {
		set_error(error, "out of memory reading root archive");
		goto cleanup;
	}
	while (offset < archive_length) {
		ssize_t received = read(descriptor, archive + offset, archive_length - offset);

		if (received < 0 && errno == EINTR)
			continue;
		if (received <= 0) {
			set_error(error, "short read from root archive");
			goto cleanup;
		}
		offset += (size_t)received;
	}

	offset = 0;
	while (offset + TAR_BLOCK <= archive_length) {
		const unsigned char *header = archive + offset;
		uint64_t expected_checksum;
		uint64_t size;
		uint64_t mode;
		uint64_t actual_checksum = 0;
		char name[101];
		char prefix[156];
		char path[PATH_MAX];
		bool directory;
		size_t padded;

		if (all_zero(header, TAR_BLOCK)) {
			zero_blocks++;
			offset += TAR_BLOCK;
			if (zero_blocks == 2U)
				break;
			continue;
		}
		if (zero_blocks != 0U || ++entries > TAR_MAX_ENTRIES) {
			set_error(error, "invalid ustar terminator or excessive entries");
			goto cleanup;
		}
		if (memcmp(header + 257U, "ustar\0", 6U) != 0 ||
		    memcmp(header + 263U, "00", 2U) != 0 ||
		    parse_octal(header, 148U, 8U, UINT64_MAX, &expected_checksum) < 0 ||
		    parse_octal(header, 124U, 12U, LABD_MAX_FILE_BYTES, &size) < 0 ||
		    parse_octal(header, 100U, 8U, 07777U, &mode) < 0 ||
		    read_field(header, 0U, 100U, name, sizeof(name)) < 0 ||
		    read_field(header, 345U, 155U, prefix, sizeof(prefix)) < 0) {
			set_error(error, "invalid constrained ustar header");
			goto cleanup;
		}
		for (size_t index = 0; index < TAR_BLOCK; index++)
			actual_checksum += index >= 148U && index < 156U ?
				' ' : header[index];
		if (actual_checksum != expected_checksum) {
			set_error(error, "ustar header checksum mismatch");
			goto cleanup;
		}
		directory = header[156U] == '5';
		if (!directory && header[156U] != '0' && header[156U] != 0U) {
			set_error(error, "unsupported non-regular ustar entry");
			goto cleanup;
		}
		if (directory && size != 0U) {
			set_error(error, "ustar directory contains a payload");
			goto cleanup;
		}
		if (prefix[0] == '\0')
			snprintf(path, sizeof(path), "%s", name);
		else if (snprintf(path, sizeof(path), "%s/%s", prefix, name) >=
			 (int)sizeof(path)) {
			set_error(error, "ustar path is too long");
			goto cleanup;
		}
		if (!valid_relative_archive_path(path, directory) || (mode & 07000U) != 0U) {
			set_error(error, "unsafe ustar path or privilege bits");
			goto cleanup;
		}
		offset += TAR_BLOCK;
		padded = ((size_t)size + TAR_BLOCK - 1U) & ~(TAR_BLOCK - 1U);
		if (padded > archive_length - offset ||
		    total_payload + (size_t)size > LABD_MAX_ARCHIVE_BYTES) {
			set_error(error, "truncated or excessive ustar payload");
			goto cleanup;
		}
		total_payload += (size_t)size;
		if (directory) {
			if (ensure_directory(root_fd, path, (mode_t)mode, error) < 0)
				goto cleanup;
		} else if (write_regular(root_fd, path, (mode_t)mode,
					 archive + offset, (size_t)size, error) < 0) {
			goto cleanup;
		}
		offset += padded;
	}
	if (zero_blocks != 2U || !all_zero(archive + offset, archive_length - offset)) {
		set_error(error, "root archive lacks a canonical zero terminator");
		goto cleanup;
	}
	status = 0;

cleanup:
	if (descriptor >= 0)
		close(descriptor);
	free(archive);
	return status;
}

static int copy_fd(int source, int destination, struct labd_error *error)
{
	unsigned char buffer[16384];

	while (true) {
		ssize_t received = read(source, buffer, sizeof(buffer));
		size_t offset = 0;

		if (received < 0 && errno == EINTR)
			continue;
		if (received < 0) {
			set_error(error, "cannot read base tree: %s", strerror(errno));
			return -1;
		}
		if (received == 0)
			return 0;
		while (offset < (size_t)received) {
			ssize_t written = write(destination, buffer + offset,
						(size_t)received - offset);
			if (written < 0 && errno == EINTR)
				continue;
			if (written <= 0) {
				set_error(error, "cannot write base tree: %s", strerror(errno));
				return -1;
			}
			offset += (size_t)written;
		}
	}
}

static int copy_tree_at(int source_fd, int destination_fd,
			struct labd_error *error)
{
	int duplicate = dup(source_fd);
	DIR *directory;
	struct dirent *entry;

	if (duplicate < 0 || (directory = fdopendir(duplicate)) == NULL) {
		if (duplicate >= 0)
			close(duplicate);
		set_error(error, "cannot enumerate base tree: %s", strerror(errno));
		return -1;
	}
	errno = 0;
	while ((entry = readdir(directory)) != NULL) {
		struct stat metadata;
		int source_child = -1;
		int destination_child = -1;
		int result = -1;

		if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0)
			continue;
		if (fstatat(source_fd, entry->d_name, &metadata, AT_SYMLINK_NOFOLLOW) < 0)
			goto entry_error;
		if (S_ISDIR(metadata.st_mode)) {
			if (mkdirat(destination_fd, entry->d_name,
				    metadata.st_mode & 0777U) < 0 && errno != EEXIST)
				goto entry_error;
			source_child = openat(source_fd, entry->d_name,
					      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
			destination_child = openat(destination_fd, entry->d_name,
						   O_RDONLY | O_DIRECTORY | O_CLOEXEC |
						   O_NOFOLLOW);
			if (source_child < 0 || destination_child < 0 ||
			    copy_tree_at(source_child, destination_child, error) < 0)
				goto entry_error;
			if (fchmod(destination_child, metadata.st_mode & 0777U) < 0)
				goto entry_error;
		} else if (S_ISREG(metadata.st_mode)) {
			source_child = openat(source_fd, entry->d_name,
					      O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
			destination_child = openat(destination_fd, entry->d_name,
						   O_WRONLY | O_CREAT | O_EXCL |
						   O_CLOEXEC | O_NOFOLLOW,
						   metadata.st_mode & 0777U);
			if (source_child < 0 || destination_child < 0 ||
			    copy_fd(source_child, destination_child, error) < 0)
				goto entry_error;
			if (fchmod(destination_child, metadata.st_mode & 0777U) < 0)
				goto entry_error;
		} else if (S_ISLNK(metadata.st_mode)) {
			char target[PATH_MAX];
			ssize_t length = readlinkat(source_fd, entry->d_name,
						    target, sizeof(target) - 1U);
			if (length < 0 || length == (ssize_t)(sizeof(target) - 1U))
				goto entry_error;
			target[length] = '\0';
			if (symlinkat(target, destination_fd, entry->d_name) < 0)
				goto entry_error;
		} else {
			/* Device nodes, sockets, and FIFOs are never copied into a node. */
			result = 0;
			goto entry_done;
		}
		result = 0;

entry_error:
		if (result < 0 && error->message[0] == '\0')
			set_error(error, "cannot copy base entry %s: %s",
				  entry->d_name, strerror(errno));
entry_done:
		if (source_child >= 0)
			close(source_child);
		if (destination_child >= 0)
			close(destination_child);
		if (result < 0) {
			closedir(directory);
			return -1;
		}
		errno = 0;
	}
	if (errno != 0) {
		set_error(error, "cannot enumerate base tree: %s", strerror(errno));
		closedir(directory);
		return -1;
	}
	closedir(directory);
	return 0;
}

int labd_copy_tree(const char *source_path, int root_fd,
		   const char *destination_name, struct labd_error *error)
{
	int source = -1;
	int destination = -1;
	int status = -1;

	if (strchr(destination_name, '/') != NULL || destination_name[0] == '\0') {
		set_error(error, "invalid base-tree destination");
		return -1;
	}
	if (mkdirat(root_fd, destination_name, 0755) < 0 && errno != EEXIST) {
		set_error(error, "cannot create base-tree destination: %s", strerror(errno));
		return -1;
	}
	source = open(source_path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
	destination = openat(root_fd, destination_name,
			     O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
	if (source < 0 || destination < 0) {
		set_error(error, "cannot open base tree: %s", strerror(errno));
		goto cleanup;
	}
	status = copy_tree_at(source, destination, error);

cleanup:
	if (source >= 0)
		close(source);
	if (destination >= 0)
		close(destination);
	return status;
}
