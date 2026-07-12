#define _GNU_SOURCE

#include "anycast-labd.h"

#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

bool labd_read_failure_detail(const char *path, char *output,
			      size_t output_size)
{
	unsigned char input[LABD_EVENT_DETAIL_BYTES - 1U];
	struct stat metadata;
	size_t received = 0U;
	size_t maximum;
	size_t written = 0U;
	bool separator = false;
	int descriptor;

	if (path == NULL || output == NULL || output_size < 2U ||
	    output_size > LABD_EVENT_DETAIL_BYTES)
		return false;
	output[0] = '\0';
	descriptor = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
	if (descriptor < 0)
		return false;
	if (fstat(descriptor, &metadata) < 0 || !S_ISREG(metadata.st_mode) ||
	    metadata.st_nlink != 1U ||
	    (metadata.st_mode & (S_IWGRP | S_IWOTH)) != 0U ||
	    metadata.st_size <= 0) {
		close(descriptor);
		return false;
	}
	if (metadata.st_size > (off_t)(output_size - 1U))
		maximum = output_size - 1U;
	else
		maximum = (size_t)metadata.st_size;
	while (received < maximum) {
		ssize_t length = read(descriptor, input + received,
				      maximum - received);

		if (length < 0 && errno == EINTR)
			continue;
		if (length <= 0) {
			close(descriptor);
			return false;
		}
		received += (size_t)length;
	}
	if (close(descriptor) < 0)
		return false;

	for (size_t index = 0; index < received; index++) {
		unsigned char byte = input[index];

		if (byte >= 0x21U && byte <= 0x7eU) {
			if (separator && written > 0U)
				output[written++] = ' ';
			output[written++] = (char)byte;
			separator = false;
		} else if (written > 0U) {
			separator = true;
		}
	}
	output[written] = '\0';
	return written > 0U;
}

void labd_output_init(struct labd_output_queue *queue)
{
	queue->head = 0U;
	queue->length = 0U;
}

size_t labd_output_pending(const struct labd_output_queue *queue)
{
	return queue->length;
}

int labd_output_enqueue(struct labd_output_queue *queue, const void *data,
			size_t length)
{
	const unsigned char *bytes = data;
	size_t tail;
	size_t first;

	if (length > LABD_CONTROL_OUTPUT_BYTES - queue->length) {
		errno = ENOBUFS;
		return -1;
	}
	if (length == 0U)
		return 0;
	tail = (queue->head + queue->length) % LABD_CONTROL_OUTPUT_BYTES;
	first = LABD_CONTROL_OUTPUT_BYTES - tail;
	if (first > length)
		first = length;
	memcpy(queue->data + tail, bytes, first);
	memcpy(queue->data, bytes + first, length - first);
	queue->length += length;
	return 0;
}

int labd_output_vprintf(struct labd_output_queue *queue, const char *format,
			va_list arguments)
{
	char line[LABD_MAX_PROTOCOL_OUTPUT_LINE + 1U];
	va_list copy;
	int length;

	va_copy(copy, arguments);
	length = vsnprintf(line, sizeof(line), format, copy);
	va_end(copy);
	if (length < 0 || (size_t)length > LABD_MAX_PROTOCOL_OUTPUT_LINE) {
		errno = length < 0 ? EILSEQ : EMSGSIZE;
		return -1;
	}
	return labd_output_enqueue(queue, line, (size_t)length);
}

int labd_output_printf(struct labd_output_queue *queue, const char *format, ...)
{
	va_list arguments;
	int result;

	va_start(arguments, format);
	result = labd_output_vprintf(queue, format, arguments);
	va_end(arguments);
	return result;
}

int labd_output_flush(struct labd_output_queue *queue, int descriptor,
		      labd_output_write_fn writer, void *context)
{
	while (queue->length > 0U) {
		size_t contiguous = LABD_CONTROL_OUTPUT_BYTES - queue->head;
		ssize_t written;

		if (contiguous > queue->length)
			contiguous = queue->length;
		written = writer(descriptor, queue->data + queue->head,
				 contiguous, context);
		if (written < 0 && errno == EINTR)
			continue;
		if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))
			return 0;
		if (written <= 0 || (size_t)written > contiguous) {
			if (written >= 0)
				errno = EIO;
			return -1;
		}
		queue->head = (queue->head + (size_t)written) %
			LABD_CONTROL_OUTPUT_BYTES;
		queue->length -= (size_t)written;
	}
	queue->head = 0U;
	return 0;
}

enum labd_apply_disposition labd_apply_disposition(bool running, bool starting,
						   bool namespace_alive)
{
	if (running)
		return LABD_APPLY_CURRENT_ROOT;
	if (starting || namespace_alive)
		return LABD_APPLY_REJECT_TRANSITION;
	return LABD_APPLY_PREPARE_ROOT;
}
