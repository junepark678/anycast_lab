#define _GNU_SOURCE

#include "anycast-labd.h"

#include <arpa/inet.h>
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <limits.h>
#include <linux/limits.h>
#include <net/if.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/signalfd.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

#define CLONE_STACK_BYTES (256U * 1024U)
#define NODE_TMPFS_BYTES (32U * 1024U * 1024U)
#define NODE_PGO_TMPFS_BYTES (96U * 1024U * 1024U)
#define NODE_MEMORY_MAX (96U * 1024U * 1024U)
#define NODE_PGO_MEMORY_MAX (192U * 1024U * 1024U)
#define NODE_PIDS_MAX 256U
#define SETUP_INTERFACES_READY 'N'
#define SETUP_ERROR 'E'
#define EVENT_READY 'R'
#define EVENT_EXIT 'X'

struct setup_message {
	char type;
};

struct node_event {
	char type;
	int32_t value;
	char detail[LABD_EVENT_DETAIL_BYTES];
};

struct labd_node {
	struct labd_node_config config;
	bool configured;
	bool starting;
	bool running;
	bool namespace_alive;
	bool prepared;
	bool runtime_mounted;
	bool stopping;
	bool exit_reported;
	pid_t launcher_pid;
	pid_t init_pid;
	int event_fd;
	void *clone_stack;
	char runtime_dir[256];
	char root_dir[256];
	char upper_dir[256];
	char work_dir[256];
	char cgroup_dir[256];
};

struct labd_terminal {
	bool used;
	unsigned int id;
	unsigned int slot;
	int master_fd;
	pid_t helper_pid;
	pid_t shell_pid;
	unsigned int columns;
	unsigned int rows;
};

struct clone_context {
	struct labd_node *node;
	int setup_fd;
	int setup_peer_fd;
	int event_fd;
	int event_peer_fd;
};

static struct labd_node nodes[LABD_MAX_NODES];
static size_t node_count;
static struct labd_terminal terminals[LABD_MAX_TERMINALS];
static unsigned int next_terminal_id = 1U;
static int control_fd = -1;
static int signal_fd = -1;
static struct labd_output_queue control_output;
static bool control_output_failed;
static volatile sig_atomic_t init_main_pid;
static volatile sig_atomic_t init_main_exited;

static void __attribute__((format(printf, 2, 3)))
format_error(struct labd_error *error, const char *format, ...)
{
	va_list arguments;

	if (error == NULL)
		return;
	va_start(arguments, format);
	vsnprintf(error->message, sizeof(error->message), format, arguments);
	va_end(arguments);
}

static int write_all(int descriptor, const void *data, size_t length)
{
	const unsigned char *bytes = data;
	size_t offset = 0;

	while (offset < length) {
		ssize_t written = write(descriptor, bytes + offset, length - offset);

		if (written < 0 && errno == EINTR)
			continue;
		if (written <= 0)
			return -1;
		offset += (size_t)written;
	}
	return 0;
}

static int write_text_file(const char *path, const char *value,
			   struct labd_error *error)
{
	int descriptor = open(path, O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
	int saved_errno;

	if (descriptor < 0 || write_all(descriptor, value, strlen(value)) < 0) {
		saved_errno = errno;
		if (descriptor >= 0)
			close(descriptor);
		format_error(error, "cannot write %s: %s", path, strerror(saved_errno));
		errno = saved_errno;
		return -1;
	}
	if (close(descriptor) < 0) {
		format_error(error, "cannot close %s: %s", path, strerror(errno));
		return -1;
	}
	return 0;
}

static int mkdir_one(const char *path, mode_t mode)
{
	if (mkdir(path, mode) < 0 && errno != EEXIST)
		return -1;
	return 0;
}

static int mkdir_parents(const char *path, mode_t mode)
{
	char copy[PATH_MAX];

	if (strlen(path) >= sizeof(copy)) {
		errno = ENAMETOOLONG;
		return -1;
	}
	memcpy(copy, path, strlen(path) + 1U);
	for (char *cursor = copy + 1; *cursor != '\0'; cursor++) {
		if (*cursor != '/')
			continue;
		*cursor = '\0';
		if (mkdir_one(copy, mode) < 0)
			return -1;
		*cursor = '/';
	}
	return mkdir_one(copy, mode);
}

static int run_program(char *const arguments[], bool quiet)
{
	pid_t child = fork();
	int status;

	if (child < 0)
		return -1;
	if (child == 0) {
		int null_fd;

		if (quiet) {
			null_fd = open("/dev/null", O_RDWR | O_CLOEXEC);
			if (null_fd >= 0) {
				dup2(null_fd, STDIN_FILENO);
				dup2(null_fd, STDOUT_FILENO);
				dup2(null_fd, STDERR_FILENO);
			}
		}
		execv(arguments[0], arguments);
		_exit(127);
	}
	while (waitpid(child, &status, 0) < 0) {
		if (errno != EINTR)
			return -1;
	}
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
		errno = EIO;
		return -1;
	}
	return 0;
}

static const char *ip_binary(void)
{
	if (access("/sbin/ip", X_OK) == 0)
		return "/sbin/ip";
	return "/usr/sbin/ip";
}

static int run_ip(const char *const values[], size_t count, bool quiet)
{
	char *arguments[20];

	if (count + 2U > sizeof(arguments) / sizeof(arguments[0])) {
		errno = E2BIG;
		return -1;
	}
	arguments[0] = (char *)ip_binary();
	for (size_t index = 0; index < count; index++)
		arguments[index + 1U] = (char *)values[index];
	arguments[count + 1U] = NULL;
	return run_program(arguments, quiet);
}

static ssize_t control_write(int descriptor, const void *data, size_t length,
			     void *context)
{
	(void)context;
	return write(descriptor, data, length);
}

static int flush_control_output(void)
{
	if (labd_output_flush(&control_output, control_fd, control_write, NULL) < 0) {
		control_output_failed = true;
		return -1;
	}
	return 0;
}

static void __attribute__((format(printf, 1, 2)))
protocol_line(const char *format, ...)
{
	va_list arguments;
	int saved_errno;

	if (control_output_failed)
		return;
	va_start(arguments, format);
	if (labd_output_vprintf(&control_output, format, arguments) < 0) {
		saved_errno = errno;
		control_output_failed = true;
		fprintf(stderr, "anycast-labd: cannot queue control output: %s\n",
			strerror(saved_errno));
	}
	va_end(arguments);
}

static void response_ok(unsigned long request_id, const char *detail)
{
	if (detail == NULL || detail[0] == '\0')
		protocol_line(LABD_PROTOCOL " OK %lu\n", request_id);
	else
		protocol_line(LABD_PROTOCOL " OK %lu %s\n", request_id, detail);
}

static void response_error(unsigned long request_id, const char *code,
			   const char *detail)
{
	if (detail == NULL || detail[0] == '\0')
		protocol_line(LABD_PROTOCOL " ERR %lu %s\n", request_id, code);
	else
		protocol_line(LABD_PROTOCOL " ERR %lu %s %s\n", request_id, code, detail);
}

static void protocol_log(unsigned int slot, const char *level,
			 const char *message)
{
	char *encoded = labd_base64_encode((const unsigned char *)message,
					   strlen(message));

	if (encoded != NULL) {
		protocol_line(LABD_PROTOCOL " LOG %u %s %s\n", slot, level, encoded);
		free(encoded);
	}
}

static int read_node_count(size_t *result, struct labd_error *error)
{
	char path[PATH_MAX];
	char buffer[32];
	int descriptor;
	ssize_t length;
	unsigned long parsed;

	snprintf(path, sizeof(path), "%s/node-count", LABD_BOOTSTRAP_ROOT);
	descriptor = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
	if (descriptor < 0) {
		format_error(error, "cannot open node-count: %s", strerror(errno));
		return -1;
	}
	length = read(descriptor, buffer, sizeof(buffer) - 1U);
	close(descriptor);
	if (length < 2 || (size_t)length >= sizeof(buffer) ||
	    buffer[length - 1] != '\n') {
		format_error(error, "node-count is not canonical");
		return -1;
	}
	buffer[length - 1] = '\0';
	if (!labd_canonical_positive(buffer, LABD_MAX_NODES, &parsed)) {
		format_error(error, "node-count is outside the supported range");
		return -1;
	}
	*result = (size_t)parsed;
	return 0;
}

static int load_bootstrap(struct labd_error *error)
{
	if (read_node_count(&node_count, error) < 0)
		return -1;
	if (mkdir_parents(LABD_RUNTIME_ROOT, 0700) < 0) {
		format_error(error, "cannot create runtime root: %s", strerror(errno));
		return -1;
	}
	for (size_t index = 0; index < node_count; index++) {
		struct labd_node *node = &nodes[index];
		char config_path[PATH_MAX];

		node->event_fd = -1;
		snprintf(config_path, sizeof(config_path), "%s/nodes/%zu/node.conf",
			 LABD_BOOTSTRAP_ROOT, index + 1U);
		if (labd_parse_node_file(config_path, (unsigned int)index + 1U,
					 &node->config, error) < 0)
			return -1;
		node->configured = true;
		if (snprintf(node->runtime_dir, sizeof(node->runtime_dir), "%s/%zu",
			     LABD_RUNTIME_ROOT, index + 1U) >= (int)sizeof(node->runtime_dir) ||
		    snprintf(node->root_dir, sizeof(node->root_dir), "%s/%zu/root",
			     LABD_RUNTIME_ROOT, index + 1U) >= (int)sizeof(node->root_dir) ||
		    snprintf(node->upper_dir, sizeof(node->upper_dir), "%s/%zu/upper",
			     LABD_RUNTIME_ROOT, index + 1U) >= (int)sizeof(node->upper_dir) ||
		    snprintf(node->work_dir, sizeof(node->work_dir), "%s/%zu/work",
			     LABD_RUNTIME_ROOT, index + 1U) >= (int)sizeof(node->work_dir) ||
		    snprintf(node->cgroup_dir, sizeof(node->cgroup_dir), "%s/node-%zu",
			     LABD_CGROUP_ROOT, index + 1U) >= (int)sizeof(node->cgroup_dir)) {
			format_error(error, "node runtime path is too long");
			return -1;
		}
	}
	return 0;
}

static struct labd_node *find_node(unsigned long slot)
{
	if (slot == 0U || slot > node_count)
		return NULL;
	return &nodes[slot - 1U];
}

static int prepare_runtime_directory(struct labd_node *node,
				     struct labd_error *error)
{
	char options[128];
	unsigned int limit = access("/etc/anycastlab/pgo-generate", F_OK) == 0 ?
		NODE_PGO_TMPFS_BYTES : NODE_TMPFS_BYTES;

	if (mkdir_parents(node->runtime_dir, 0700) < 0) {
		format_error(error, "cannot prepare node runtime directory: %s",
			     strerror(errno));
		return -1;
	}
	snprintf(options, sizeof(options), "size=%u,nr_inodes=8192,mode=0700", limit);
	if (mount("tmpfs", node->runtime_dir, "tmpfs", MS_NOSUID | MS_NODEV,
		  options) < 0) {
		format_error(error, "cannot mount bounded node runtime tmpfs: %s",
			     strerror(errno));
		return -1;
	}
	node->runtime_mounted = true;
	if (mkdir_one(node->root_dir, 0700) < 0 ||
	    mkdir_one(node->upper_dir, 0700) < 0 ||
	    mkdir_one(node->work_dir, 0700) < 0) {
		format_error(error, "cannot prepare node runtime directory: %s",
			     strerror(errno));
		(void)umount2(node->runtime_dir, MNT_DETACH);
		node->runtime_mounted = false;
		return -1;
	}
	return 0;
}

static int enable_controller(const char *path, const char *controller)
{
	int descriptor = open(path, O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
	char value[32];

	if (descriptor < 0)
		return -1;
	snprintf(value, sizeof(value), "+%s", controller);
	if (write_all(descriptor, value, strlen(value)) < 0) {
		close(descriptor);
		return -1;
	}
	return close(descriptor);
}

static int prepare_cgroup_root(struct labd_error *error)
{
	char subtree[PATH_MAX];

	if (access("/sys/fs/cgroup/cgroup.controllers", R_OK) < 0) {
		format_error(error, "a mounted cgroup-v2 hierarchy is required");
		return -1;
	}
	if (mkdir_one(LABD_CGROUP_ROOT, 0755) < 0) {
		format_error(error, "cannot create cgroup root: %s", strerror(errno));
		return -1;
	}
	snprintf(subtree, sizeof(subtree), "%s/cgroup.subtree_control",
		 "/sys/fs/cgroup");
	if (enable_controller(subtree, "cpu") < 0 ||
	    enable_controller(subtree, "memory") < 0 ||
	    enable_controller(subtree, "pids") < 0) {
		format_error(error, "cannot enable root cgroup controllers: %s",
			     strerror(errno));
		return -1;
	}
	snprintf(subtree, sizeof(subtree), "%s/cgroup.subtree_control",
		 LABD_CGROUP_ROOT);
	if (enable_controller(subtree, "cpu") < 0 ||
	    enable_controller(subtree, "memory") < 0 ||
	    enable_controller(subtree, "pids") < 0) {
		format_error(error, "cannot delegate node cgroup controllers: %s",
			     strerror(errno));
		return -1;
	}
	return 0;
}

static int attach_cgroup(struct labd_node *node, pid_t pid,
			 struct labd_error *error)
{
	char path[PATH_MAX];
	char value[64];
	unsigned int memory_limit =
		access("/etc/anycastlab/pgo-generate", F_OK) == 0 ?
		NODE_PGO_MEMORY_MAX : NODE_MEMORY_MAX;

	if (mkdir_one(node->cgroup_dir, 0755) < 0) {
		format_error(error, "cannot create node cgroup: %s", strerror(errno));
		return -1;
	}
	snprintf(path, sizeof(path), "%s/memory.max", node->cgroup_dir);
	snprintf(value, sizeof(value), "%u\n", memory_limit);
	if (write_text_file(path, value, error) < 0)
		return -1;
	snprintf(path, sizeof(path), "%s/memory.swap.max", node->cgroup_dir);
	if (access(path, F_OK) == 0 && write_text_file(path, "0\n", error) < 0)
		return -1;
	snprintf(path, sizeof(path), "%s/pids.max", node->cgroup_dir);
	snprintf(value, sizeof(value), "%u\n", NODE_PIDS_MAX);
	if (write_text_file(path, value, error) < 0)
		return -1;
	snprintf(path, sizeof(path), "%s/cpu.weight", node->cgroup_dir);
	if (write_text_file(path, "100\n", error) < 0)
		return -1;
	snprintf(path, sizeof(path), "%s/cgroup.procs", node->cgroup_dir);
	snprintf(value, sizeof(value), "%ld\n", (long)pid);
	return write_text_file(path, value, error);
}

static bool interface_uses_driver(const char *name, const char *driver)
{
	char path[PATH_MAX];
	char target[PATH_MAX];
	const char *basename;
	int path_length;
	ssize_t length;

	path_length = snprintf(path, sizeof(path),
			       "/sys/class/net/%s/device/driver", name);
	if (path_length < 0 || path_length >= (int)sizeof(path))
		return false;
	length = readlink(path, target, sizeof(target) - 1U);
	if (length < 0)
		return false;
	target[length] = '\0';
	basename = strrchr(target, '/');
	basename = basename == NULL ? target : basename + 1;
	return strcmp(basename, driver) == 0;
}

static int find_initial_interface(char output[IFNAMSIZ])
{
	DIR *directory = opendir("/sys/class/net");
	struct dirent *entry;
	unsigned int selected_index = 0U;

	if (directory == NULL)
		return -1;
	while ((entry = readdir(directory)) != NULL) {
		unsigned int index;

		if (entry->d_name[0] == '.' ||
		    strcmp(entry->d_name, LABD_TRUNK_DEFAULT) == 0)
			continue;
		if (strlen(entry->d_name) >= IFNAMSIZ ||
		    !interface_uses_driver(entry->d_name, "virtio_net"))
			continue;
		index = if_nametoindex(entry->d_name);
		if (index == 0U || (selected_index != 0U && index >= selected_index))
			continue;
		selected_index = index;
		memcpy(output, entry->d_name, strlen(entry->d_name) + 1U);
	}
	closedir(directory);
	if (selected_index != 0U)
		return 0;
	errno = ENODEV;
	return -1;
}

static int prepare_trunk(struct labd_error *error)
{
	char physical[IFNAMSIZ];
	const char *rename_down[4];
	const char *rename[5];
	const char *up[] = { "link", "set", "dev", LABD_TRUNK_DEFAULT,
			     "mtu", "65535", "promisc", "on", "up" };

	if (if_nametoindex(LABD_TRUNK_DEFAULT) != 0U)
		return run_ip(up, sizeof(up) / sizeof(up[0]), true);
	if (find_initial_interface(physical) < 0) {
		format_error(error, "cannot find the v86 trunk interface");
		return -1;
	}
	rename_down[0] = "link";
	rename_down[1] = "set";
	rename_down[2] = physical;
	rename_down[3] = "down";
	if (run_ip(rename_down, 4U, true) < 0) {
		format_error(error, "cannot lower trunk interface");
		return -1;
	}
	rename[0] = "link";
	rename[1] = "set";
	rename[2] = physical;
	rename[3] = "name";
	rename[4] = LABD_TRUNK_DEFAULT;
	if (run_ip(rename, 5U, true) < 0 ||
	    run_ip(up, sizeof(up) / sizeof(up[0]), true) < 0) {
		format_error(error, "cannot configure trunk interface");
		return -1;
	}
	return 0;
}

static int attach_interfaces(struct labd_node *node, struct labd_error *error)
{
	char vlan[16];
	char pid[32];

	if (node->config.interface_count != 0U && prepare_trunk(error) < 0)
		return -1;
	snprintf(pid, sizeof(pid), "%ld", (long)node->init_pid);
	for (size_t index = 0; index < node->config.interface_count; index++) {
		struct labd_interface *interface = &node->config.interfaces[index];
		const char *create[] = { "link", "add", "link", LABD_TRUNK_DEFAULT,
			"name", interface->staging_name, "type", "vlan", "id", vlan };
		const char *move[] = { "link", "set", "dev", interface->staging_name,
			"netns", pid };

		snprintf(vlan, sizeof(vlan), "%u", interface->vlan);
		if (run_ip(create, sizeof(create) / sizeof(create[0]), true) < 0 ||
		    run_ip(move, sizeof(move) / sizeof(move[0]), true) < 0) {
			const char *remove[] = { "link", "delete", interface->staging_name };
			(void)run_ip(remove, sizeof(remove) / sizeof(remove[0]), true);
			format_error(error, "cannot attach VLAN %u to node %u",
				     interface->vlan, node->config.slot);
			return -1;
		}
	}
	return 0;
}

static int remove_tree_at(int parent_fd, const char *name)
{
	if (parent_fd < 0) {
		errno = EBADF;
		return -1;
	}
	int descriptor = openat(parent_fd, name,
				O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);

	if (descriptor >= 0) {
		DIR *directory = fdopendir(descriptor);
		struct dirent *entry;

		if (directory == NULL) {
			close(descriptor);
			return -1;
		}
		errno = 0;
		while ((entry = readdir(directory)) != NULL) {
			if (strcmp(entry->d_name, ".") == 0 ||
			    strcmp(entry->d_name, "..") == 0)
				continue;
			if (remove_tree_at(dirfd(directory), entry->d_name) < 0) {
				closedir(directory);
				return -1;
			}
			errno = 0;
		}
		if (errno != 0) {
			closedir(directory);
			return -1;
		}
		closedir(directory);
		return unlinkat(parent_fd, name, AT_REMOVEDIR);
	}
	if (errno != ENOTDIR)
		return -1;
	return unlinkat(parent_fd, name, 0);
}

static int remove_runtime_directory(struct labd_node *node)
{
	int parent = open(LABD_RUNTIME_ROOT,
			  O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
	char slot[32];
	int result;

	if (parent < 0)
		return errno == ENOENT ? 0 : -1;
	snprintf(slot, sizeof(slot), "%u", node->config.slot);
	result = remove_tree_at(parent, slot);
	int saved_errno = 0;
	if (result < 0) {
		saved_errno = errno;
		if (saved_errno == ENOENT)
			result = 0;
	}
	close(parent);
	if (saved_errno != 0)
		errno = saved_errno;
	return result;
}

static int prepare_base_root(struct labd_error *error)
{
	if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) < 0) {
		format_error(error, "cannot make host mounts private: %s", strerror(errno));
		return -1;
	}
	if (mkdir_parents(LABD_BASE_ROOT, 0700) < 0) {
		format_error(error, "cannot create shared lower root: %s", strerror(errno));
		return -1;
	}
	if (mount("/", LABD_BASE_ROOT, NULL, MS_BIND, NULL) < 0 ||
	    mount(NULL, LABD_BASE_ROOT, NULL,
		  MS_BIND | MS_REMOUNT | MS_RDONLY | MS_NOSUID | MS_NODEV, NULL) < 0) {
		format_error(error, "cannot bind the immutable shared lower root: %s",
			     strerror(errno));
		return -1;
	}
	return 0;
}

static int prepare_node_root(struct labd_node *node, struct labd_error *error)
{
	char options[PATH_MAX * 3U];
	char archive[PATH_MAX];
	int root_fd;

	if (node->prepared)
		return 0;
	if (prepare_runtime_directory(node, error) < 0)
		return -1;
	if (snprintf(options, sizeof(options),
		     "lowerdir=%s,upperdir=%s,workdir=%s,index=off,xino=off,redirect_dir=off",
		     LABD_BASE_ROOT, node->upper_dir, node->work_dir) >=
	    (int)sizeof(options)) {
		format_error(error, "overlay mount options exceed PATH_MAX");
		return -1;
	}
	if (mount("overlay", node->root_dir, "overlay",
		  MS_NOSUID | MS_NODEV, options) < 0) {
		format_error(error, "cannot mount node overlay root: %s", strerror(errno));
		(void)umount2(node->runtime_dir, MNT_DETACH);
		node->runtime_mounted = false;
		return -1;
	}
	root_fd = open(node->root_dir,
		       O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
	snprintf(archive, sizeof(archive), "%s/nodes/%u/root.tar",
		 LABD_BOOTSTRAP_ROOT, node->config.slot);
	if (root_fd < 0 || labd_extract_ustar(archive, root_fd, error) < 0) {
		if (root_fd >= 0)
			close(root_fd);
		(void)umount2(node->root_dir, MNT_DETACH);
		(void)umount2(node->runtime_dir, MNT_DETACH);
		node->runtime_mounted = false;
		return -1;
	}
	close(root_fd);
	node->prepared = true;
	return 0;
}

static int node_path(char output[PATH_MAX], const struct labd_node *node,
		     const char *suffix)
{
	int length = snprintf(output, PATH_MAX, "%s%s", node->root_dir, suffix);

	if (length < 0 || length >= PATH_MAX) {
		errno = ENAMETOOLONG;
		return -1;
	}
	return 0;
}

static int ensure_node_directory(const struct labd_node *node,
				 const char *suffix, mode_t mode)
{
	char path[PATH_MAX];

	if (node_path(path, node, suffix) < 0)
		return -1;
	return mkdir_parents(path, mode);
}

static int make_node_device(const struct labd_node *node, const char *suffix,
			    mode_t mode, unsigned int major_number,
			    unsigned int minor_number)
{
	char path[PATH_MAX];

	if (node_path(path, node, suffix) < 0)
		return -1;
	if (mknod(path, S_IFCHR | mode, makedev(major_number, minor_number)) < 0 &&
	    errno != EEXIST)
		return -1;
	return 0;
}

static int prepare_node_mounts(struct labd_node *node, struct labd_error *error)
{
	char dev[PATH_MAX];
	char devpts[PATH_MAX];
	char proc[PATH_MAX];
	char sys[PATH_MAX];
	char ptmx[PATH_MAX];

	if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) < 0 ||
	    ensure_node_directory(node, "/dev", 0755) < 0 ||
	    ensure_node_directory(node, "/dev/pts", 0755) < 0 ||
	    ensure_node_directory(node, "/proc", 0555) < 0 ||
	    ensure_node_directory(node, "/sys", 0555) < 0 ||
	    node_path(dev, node, "/dev") < 0 ||
	    node_path(devpts, node, "/dev/pts") < 0 ||
	    node_path(proc, node, "/proc") < 0 ||
	    node_path(sys, node, "/sys") < 0) {
		format_error(error, "cannot prepare node mountpoints: %s", strerror(errno));
		return -1;
	}
	if (mount("tmpfs", dev, "tmpfs", MS_NOSUID,
		  "mode=0755,size=256k,nr_inodes=64") < 0 ||
	    mkdir_parents(devpts, 0755) < 0 ||
	    make_node_device(node, "/dev/null", 0666, 1U, 3U) < 0 ||
	    make_node_device(node, "/dev/zero", 0666, 1U, 5U) < 0 ||
	    make_node_device(node, "/dev/full", 0666, 1U, 7U) < 0 ||
	    make_node_device(node, "/dev/random", 0666, 1U, 8U) < 0 ||
	    make_node_device(node, "/dev/urandom", 0666, 1U, 9U) < 0 ||
	    make_node_device(node, "/dev/tty", 0666, 5U, 0U) < 0 ||
	    mount("devpts", devpts, "devpts", MS_NOSUID | MS_NOEXEC,
		  "newinstance,mode=0620,ptmxmode=0666") < 0 ||
	    mount("proc", proc, "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL) < 0 ||
	    mount("sysfs", sys, "sysfs", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL) < 0) {
		format_error(error, "cannot mount isolated node pseudo-filesystems: %s",
			     strerror(errno));
		return -1;
	}
	if (node_path(ptmx, node, "/dev/ptmx") < 0)
		return -1;
	if (symlink("pts/ptmx", ptmx) < 0 && errno != EEXIST) {
		format_error(error, "cannot create isolated ptmx link: %s", strerror(errno));
		return -1;
	}
	return 0;
}

static int configure_node_network(struct labd_node *node,
				  struct labd_error *error)
{
	const char *loopback[] = { "link", "set", "dev", "lo", "up" };

	if (write_text_file("/proc/sys/net/ipv4/ip_forward", "1\n", error) < 0 ||
	    write_text_file("/proc/sys/net/ipv6/conf/all/forwarding", "1\n", error) < 0 ||
	    run_ip(loopback, sizeof(loopback) / sizeof(loopback[0]), true) < 0) {
		if (error->message[0] == '\0')
			format_error(error, "cannot raise node loopback interface");
		return -1;
	}
	for (size_t index = 0; index < node->config.interface_count; index++) {
		struct labd_interface *interface = &node->config.interfaces[index];
		char mtu[16];
		const char *lower[] = { "link", "set", "dev", interface->staging_name,
			"down" };
		const char *rename[] = { "link", "set", "dev", interface->staging_name,
			"name", interface->name };
		const char *properties[] = { "link", "set", "dev", interface->name,
			"address", interface->mac_text, "mtu", mtu };
		const char *arp[] = { "link", "set", "dev", interface->name,
			"arp", "on" };
		const char *state[] = { "link", "set", "dev", interface->name,
			interface->up ? "up" : "down" };

		snprintf(mtu, sizeof(mtu), "%u", interface->mtu);
		if (run_ip(lower, sizeof(lower) / sizeof(lower[0]), true) < 0 ||
		    run_ip(rename, sizeof(rename) / sizeof(rename[0]), true) < 0 ||
		    run_ip(properties, sizeof(properties) / sizeof(properties[0]), true) < 0 ||
		    run_ip(arp, sizeof(arp) / sizeof(arp[0]), true) < 0) {
			format_error(error, "cannot configure node interface %s",
				     interface->name);
			return -1;
		}
		for (size_t address_index = 0;
		     address_index < node->config.address_count; address_index++) {
			struct labd_address *address = &node->config.addresses[address_index];
			char value[96];
			const char *arguments[7];
			size_t count = 0;

			if (address->interface_index != index)
				continue;
			snprintf(value, sizeof(value), "%s/%u", address->text,
				 address->prefix);
			if (address->family == AF_INET6)
				arguments[count++] = "-6";
			arguments[count++] = "address";
			arguments[count++] = "add";
			arguments[count++] = value;
			arguments[count++] = "dev";
			arguments[count++] = interface->name;
			if (run_ip(arguments, count, true) < 0) {
				format_error(error, "cannot assign %s to %s", value,
					     interface->name);
				return -1;
			}
		}
		if (run_ip(state, sizeof(state) / sizeof(state[0]), true) < 0) {
			format_error(error, "cannot set node interface %s %s",
				     interface->name, interface->up ? "up" : "down");
			return -1;
		}
	}
	return 0;
}

static int send_node_event(int descriptor, char type, int32_t value,
			   const char *detail)
{
	struct node_event event;

	memset(&event, 0, sizeof(event));
	event.type = type;
	event.value = value;
	if (detail != NULL)
		snprintf(event.detail, sizeof(event.detail), "%s", detail);
	return write_all(descriptor, &event, sizeof(event));
}

static void node_init_signal(int signal_number)
{
	(void)signal_number;
	init_main_exited = 1;
	/* The entrypoint is the node session leader and owns graceful descendant
	 * shutdown. In particular, FRR's wrapper must run its stop service before
	 * the parent supervisor escalates by killing namespace PID 1. */
	if (init_main_pid > 0)
		(void)kill(init_main_pid, SIGTERM);
}

static void reset_child_signals(void)
{
	struct sigaction action;

	memset(&action, 0, sizeof(action));
	action.sa_handler = SIG_DFL;
	sigemptyset(&action.sa_mask);
	for (int signal_number = 1; signal_number < NSIG; signal_number++) {
		if (signal_number != SIGKILL && signal_number != SIGSTOP)
			(void)sigaction(signal_number, &action, NULL);
	}
	sigset_t empty;
	sigemptyset(&empty);
	(void)sigprocmask(SIG_SETMASK, &empty, NULL);
}

static void execute_node_entrypoint(struct labd_node *node)
{
	char *arguments[LABD_MAX_ARGS + 2U];
	int null_fd;

	reset_child_signals();
	(void)setsid();
	umask(0022);
	if (clearenv() < 0)
		_exit(126);
	(void)setenv("PATH", "/usr/sbin:/usr/bin:/sbin:/bin", 1);
	(void)setenv("HOME", "/root", 1);
	(void)setenv("TERM", "xterm-256color", 1);
	(void)setenv("HOSTNAME", node->config.hostname, 1);
	for (size_t index = 0; index < node->config.env_count; index++) {
		if (setenv(node->config.env[index].name,
			   node->config.env[index].value, 1) < 0)
			_exit(126);
	}
	if (node->config.kind != LABD_KIND_CLIENT &&
	    access("/etc/anycastlab/pgo-generate", F_OK) == 0) {
		const char *kind = node->config.kind == LABD_KIND_BIRD ? "bird" : "frr";
		char profile[160];

		if (mkdir("/tmp/anycast-pgo", 01777) < 0 && errno != EEXIST)
			_exit(126);
		(void)chmod("/tmp/anycast-pgo", 01777);
		snprintf(profile, sizeof(profile),
			 "/tmp/anycast-pgo/daemon-%s_%%m_%%p.profraw", kind);
		(void)setenv("LLVM_PROFILE_FILE", profile, 1);
	}
	arguments[0] = node->config.entrypoint;
	for (size_t index = 0; index < node->config.argc; index++)
		arguments[index + 1U] = node->config.argv[index];
	arguments[node->config.argc + 1U] = NULL;
	null_fd = open("/dev/null", O_RDWR);
	if (null_fd >= 0) {
		(void)dup2(null_fd, STDIN_FILENO);
		(void)dup2(null_fd, STDOUT_FILENO);
		(void)dup2(null_fd, STDERR_FILENO);
		if (null_fd > STDERR_FILENO)
			close(null_fd);
	}
	execv(arguments[0], arguments);
	_exit(errno == ENOENT ? 127 : 126);
}

static bool node_entrypoint_ready(struct labd_node *node)
{
	if (node->config.kind == LABD_KIND_CLIENT)
		return true;
	if (node->config.kind == LABD_KIND_BIRD) {
		char *arguments[] = { "/usr/sbin/birdc", "show", "status", NULL };
		struct stat control_socket;

		return lstat("/var/run/bird.ctl", &control_socket) == 0 &&
			S_ISSOCK(control_socket.st_mode) &&
			run_program(arguments, true) == 0;
	}
	/* The trusted FRR wrapper owns this archive-reserved marker and writes it
	 * only after watchfrr is alive. Re-running aggregate
	 * frrinit status here would make one bad protocol configuration hide the
	 * namespace terminal that users need to diagnose it. */
	return access("/run/anycastlab/frr.ready", F_OK) == 0;
}

static int node_namespace_init(void *opaque)
{
	struct clone_context *context = opaque;
	struct labd_node *node = context->node;
	struct setup_message setup;
	struct labd_error error = { { 0 } };
	struct sigaction action;
	pid_t main_pid;
	int status = 0;
	bool main_reaped = false;
	sigset_t empty_mask;

	close(context->setup_peer_fd);
	close(context->event_peer_fd);
	sigemptyset(&empty_mask);
	(void)sigprocmask(SIG_SETMASK, &empty_mask, NULL);
	(void)prctl(PR_SET_PDEATHSIG, SIGKILL);
	memset(&action, 0, sizeof(action));
	action.sa_handler = node_init_signal;
	sigemptyset(&action.sa_mask);
	action.sa_flags = SA_RESTART;
	(void)sigaction(SIGTERM, &action, NULL);
	(void)sigaction(SIGINT, &action, NULL);
	(void)sigaction(SIGHUP, &action, NULL);

	if (read(context->setup_fd, &setup, sizeof(setup)) != (ssize_t)sizeof(setup) ||
	    setup.type != SETUP_INTERFACES_READY) {
		(void)send_node_event(context->event_fd, SETUP_ERROR, errno,
				      "supervisor setup channel closed");
		return 125;
	}
	close(context->setup_fd);
	/* The parent has moved us into node->cgroup_dir before releasing this setup
	 * channel, so unsharing now makes that directory appear as cgroup '/'.
	 * CLONE_NEWTIME occupies the legacy clone(2) exit-signal byte; create a
	 * time-for-children namespace here instead. The daemon and every terminal
	 * process enter it while the tiny namespace init supervises from parent time. */
	if (unshare(CLONE_NEWCGROUP) < 0 || unshare(CLONE_NEWTIME) < 0 ||
	    configure_node_network(node, &error) < 0 ||
	    prepare_node_mounts(node, &error) < 0 ||
	    sethostname(node->config.hostname, strlen(node->config.hostname)) < 0 ||
	    chroot(node->root_dir) < 0 || chdir("/") < 0) {
		if (error.message[0] == '\0')
			format_error(&error, "namespace setup failed: %s", strerror(errno));
		(void)send_node_event(context->event_fd, SETUP_ERROR, errno,
				      error.message);
		return 125;
	}
	if (unlink(LABD_ENTRYPOINT_FAILURE_PATH) < 0 && errno != ENOENT) {
		(void)send_node_event(context->event_fd, SETUP_ERROR, errno,
				      "cannot clear reserved entrypoint failure marker");
		return 125;
	}

	main_pid = fork();
	if (main_pid < 0) {
		(void)send_node_event(context->event_fd, SETUP_ERROR, errno,
				      "cannot fork node entrypoint");
		return 125;
	}
	if (main_pid == 0)
		execute_node_entrypoint(node);
	init_main_pid = main_pid;

	for (unsigned int attempt = 0; attempt < 480U; attempt++) {
		pid_t result = waitpid(main_pid, &status, WNOHANG);

		if (result == main_pid) {
			main_reaped = true;
			break;
		}
		if (result < 0 && errno != EINTR) {
			main_reaped = true;
			break;
		}
		if (init_main_exited)
			break;
		if (node_entrypoint_ready(node)) {
			if (send_node_event(context->event_fd, EVENT_READY, main_pid, "") < 0) {
				(void)kill(-main_pid, SIGKILL);
				(void)kill(main_pid, SIGKILL);
			}
			break;
		}
		struct timespec delay = { .tv_sec = 0, .tv_nsec = 250000000L };
		(void)nanosleep(&delay, NULL);
		if (attempt == 479U) {
			(void)send_node_event(context->event_fd, SETUP_ERROR, ETIMEDOUT,
					      "entrypoint readiness probe timed out");
			(void)kill(-main_pid, SIGTERM);
			(void)kill(main_pid, SIGTERM);
		}
	}

	while (!main_reaped) {
		pid_t child = waitpid(-1, &status, 0);

		/* The parent supervisor owns the stop deadline and kills namespace PID 1
		 * if it expires. Waiting here lets the entrypoint finish its complete
		 * daemon shutdown without a second, competing escalation timer. */
		if (child < 0 && errno == EINTR)
			continue;
		if (child < 0) {
			if (errno == ECHILD)
				main_reaped = true;
			continue;
		}
		if (child == main_pid)
			main_reaped = true;
	}

	char reason[LABD_EVENT_DETAIL_BYTES];
	if (node->config.kind == LABD_KIND_FRR &&
	    labd_read_failure_detail(LABD_ENTRYPOINT_FAILURE_PATH, reason,
				     sizeof(reason))) {
		/* The trusted FRR wrapper writes a fixed, bounded diagnostic. */
	} else if (WIFEXITED(status))
		snprintf(reason, sizeof(reason), "entrypoint exited with status %d",
			 WEXITSTATUS(status));
	else if (WIFSIGNALED(status))
		snprintf(reason, sizeof(reason), "entrypoint terminated by signal %d",
			 WTERMSIG(status));
	else
		snprintf(reason, sizeof(reason), "entrypoint exited unexpectedly");
	(void)send_node_event(context->event_fd, EVENT_EXIT, status, reason);
	close(context->event_fd);
	return WIFEXITED(status) ? WEXITSTATUS(status) : 128;
}

static int send_setup_ready(int descriptor)
{
	struct setup_message message;

	memset(&message, 0, sizeof(message));
	message.type = SETUP_INTERFACES_READY;
	return write_all(descriptor, &message, sizeof(message));
}

static void cleanup_node_process(struct labd_node *node)
{
	char path[PATH_MAX];

	if (node->event_fd >= 0) {
		close(node->event_fd);
		node->event_fd = -1;
	}
	free(node->clone_stack);
	node->clone_stack = NULL;
	node->launcher_pid = 0;
	node->init_pid = 0;
	node->starting = false;
	node->running = false;
	node->namespace_alive = false;
	node->stopping = false;
	snprintf(path, sizeof(path), "%s/cgroup.procs", node->cgroup_dir);
	if (access(path, F_OK) == 0)
		(void)rmdir(node->cgroup_dir);
}

static int start_node(struct labd_node *node, struct labd_error *error)
{
	int setup_pair[2] = { -1, -1 };
	int event_pair[2] = { -1, -1 };
	struct clone_context context;
	pid_t child;
	int flags = CLONE_NEWNS | CLONE_NEWPID | CLONE_NEWNET | CLONE_NEWUTS |
		CLONE_NEWIPC | SIGCHLD;
	int status = -1;

	if (node->running || node->starting || node->namespace_alive) {
		format_error(error, "node is already running");
		errno = EBUSY;
		return -1;
	}
	if (prepare_node_root(node, error) < 0)
		return -1;
	if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, setup_pair) < 0 ||
	    socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, event_pair) < 0) {
		format_error(error, "cannot create namespace setup channels: %s",
			     strerror(errno));
		goto cleanup;
	}
	node->clone_stack = malloc(CLONE_STACK_BYTES);
	if (node->clone_stack == NULL) {
		format_error(error, "cannot allocate namespace clone stack");
		goto cleanup;
	}
	context.node = node;
	context.setup_fd = setup_pair[1];
	context.setup_peer_fd = setup_pair[0];
	context.event_fd = event_pair[1];
	context.event_peer_fd = event_pair[0];
	child = clone(node_namespace_init,
		      (unsigned char *)node->clone_stack + CLONE_STACK_BYTES,
		      flags, &context);
	if (child < 0) {
		format_error(error, "cannot clone isolated node namespaces: %s",
			     strerror(errno));
		goto cleanup;
	}
	close(setup_pair[1]);
	setup_pair[1] = -1;
	close(event_pair[1]);
	event_pair[1] = -1;
	node->launcher_pid = child;
	node->init_pid = child;
	node->event_fd = event_pair[0];
	event_pair[0] = -1;
	node->starting = true;
	node->namespace_alive = true;
	node->exit_reported = false;
	if (attach_cgroup(node, child, error) < 0 ||
	    attach_interfaces(node, error) < 0 ||
	    send_setup_ready(setup_pair[0]) < 0) {
		int saved_errno = errno;
		(void)kill(child, SIGKILL);
		while (waitpid(child, NULL, 0) < 0 && errno == EINTR)
			;
		cleanup_node_process(node);
		errno = saved_errno;
		if (error->message[0] == '\0')
			format_error(error, "cannot finish node namespace setup: %s",
				     strerror(errno));
		goto cleanup;
	}
	status = 0;

cleanup:
	for (size_t index = 0; index < 2U; index++) {
		if (setup_pair[index] >= 0)
			close(setup_pair[index]);
		if (event_pair[index] >= 0)
			close(event_pair[index]);
	}
	if (status < 0 && !node->namespace_alive) {
		free(node->clone_stack);
		node->clone_stack = NULL;
	}
	return status;
}

static int wait_for_node_exit(struct labd_node *node, unsigned int attempts)
{
	for (unsigned int attempt = 0; attempt < attempts; attempt++) {
		pid_t result = waitpid(node->launcher_pid, NULL, WNOHANG);

		if (result == node->launcher_pid || (result < 0 && errno == ECHILD))
			return 0;
		if (result < 0 && errno != EINTR)
			return -1;
		struct timespec delay = { .tv_sec = 0, .tv_nsec = 100000000L };
		(void)nanosleep(&delay, NULL);
	}
	errno = ETIMEDOUT;
	return -1;
}

static int stop_node_with_grace(struct labd_node *node, unsigned int attempts,
				struct labd_error *error)
{
	if (!node->namespace_alive)
		return 0;
	node->stopping = true;
	if (kill(node->launcher_pid, SIGTERM) < 0 && errno != ESRCH) {
		format_error(error, "cannot stop node namespace: %s", strerror(errno));
		return -1;
	}
	if (wait_for_node_exit(node, attempts) < 0) {
		(void)kill(node->launcher_pid, SIGKILL);
		if (wait_for_node_exit(node, 20U) < 0) {
			format_error(error, "node namespace did not terminate: %s",
				     strerror(errno));
			return -1;
		}
	}
	cleanup_node_process(node);
	return 0;
}

static int stop_node(struct labd_node *node, struct labd_error *error)
{
	return stop_node_with_grace(node, 60U, error);
}

struct namespace_fds {
	int mount_fd;
	int net_fd;
	int uts_fd;
	int ipc_fd;
	int cgroup_fd;
	int time_fd;
	int pid_fd;
};

static void close_namespace_fds(struct namespace_fds *fds)
{
	int *values = (int *)fds;

	for (size_t index = 0; index < sizeof(*fds) / sizeof(int); index++) {
		if (values[index] >= 0)
			close(values[index]);
		values[index] = -1;
	}
}

static int open_namespace_fd(pid_t pid, const char *name)
{
	char path[PATH_MAX];

	snprintf(path, sizeof(path), "/proc/%ld/ns/%s", (long)pid, name);
	return open(path, O_RDONLY | O_CLOEXEC);
}

static int open_node_namespaces(struct labd_node *node,
				struct namespace_fds *fds)
{
	memset(fds, 0xff, sizeof(*fds));
	fds->mount_fd = open_namespace_fd(node->init_pid, "mnt");
	fds->net_fd = open_namespace_fd(node->init_pid, "net");
	fds->uts_fd = open_namespace_fd(node->init_pid, "uts");
	fds->ipc_fd = open_namespace_fd(node->init_pid, "ipc");
	fds->cgroup_fd = open_namespace_fd(node->init_pid, "cgroup");
	fds->time_fd = open_namespace_fd(node->init_pid, "time_for_children");
	fds->pid_fd = open_namespace_fd(node->init_pid, "pid");
	if (fds->mount_fd < 0 || fds->net_fd < 0 || fds->uts_fd < 0 ||
	    fds->ipc_fd < 0 || fds->cgroup_fd < 0 || fds->time_fd < 0 ||
	    fds->pid_fd < 0) {
		close_namespace_fds(fds);
		return -1;
	}
	return 0;
}

static int enter_node_namespaces(struct namespace_fds *fds, bool pid_for_child)
{
	if (setns(fds->cgroup_fd, CLONE_NEWCGROUP) < 0 ||
	    setns(fds->uts_fd, CLONE_NEWUTS) < 0 ||
	    setns(fds->ipc_fd, CLONE_NEWIPC) < 0 ||
	    setns(fds->net_fd, CLONE_NEWNET) < 0 ||
	    setns(fds->time_fd, CLONE_NEWTIME) < 0 ||
	    setns(fds->mount_fd, CLONE_NEWNS) < 0 ||
	    (pid_for_child && setns(fds->pid_fd, CLONE_NEWPID) < 0))
		return -1;
	return 0;
}

static int set_node_link(struct labd_node *node, const char *name, bool up,
			 struct labd_error *error)
{
	pid_t child = fork();
	int status;

	if (child < 0) {
		format_error(error, "cannot fork link helper: %s", strerror(errno));
		return -1;
	}
	if (child == 0) {
		struct namespace_fds fds;
		const char *arguments[] = { "link", "set", "dev", name,
			up ? "up" : "down" };

		if (open_node_namespaces(node, &fds) < 0 ||
		    setns(fds.net_fd, CLONE_NEWNET) < 0)
			_exit(125);
		close_namespace_fds(&fds);
		_exit(run_ip(arguments, sizeof(arguments) / sizeof(arguments[0]),
			     true) == 0 ? 0 : 1);
	}
	while (waitpid(child, &status, 0) < 0) {
		if (errno != EINTR) {
			format_error(error, "cannot wait for link helper: %s", strerror(errno));
			return -1;
		}
	}
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
		format_error(error, "cannot set node interface %s %s", name,
			     up ? "up" : "down");
		return -1;
	}
	return 0;
}

static int send_terminal_descriptor(int socket_fd, int master_fd,
				    pid_t shell_pid)
{
	struct msghdr message;
	struct iovec vector;
	char control[CMSG_SPACE(sizeof(int))];
	struct cmsghdr *header;

	memset(&message, 0, sizeof(message));
	memset(control, 0, sizeof(control));
	vector.iov_base = &shell_pid;
	vector.iov_len = sizeof(shell_pid);
	message.msg_iov = &vector;
	message.msg_iovlen = 1;
	message.msg_control = control;
	message.msg_controllen = sizeof(control);
	header = CMSG_FIRSTHDR(&message);
	header->cmsg_level = SOL_SOCKET;
	header->cmsg_type = SCM_RIGHTS;
	header->cmsg_len = CMSG_LEN(sizeof(int));
	memcpy(CMSG_DATA(header), &master_fd, sizeof(master_fd));
	return sendmsg(socket_fd, &message, 0) == (ssize_t)sizeof(shell_pid) ? 0 : -1;
}

static int receive_terminal_descriptor(int socket_fd, int *master_fd,
				       pid_t *shell_pid)
{
	struct msghdr message;
	struct iovec vector;
	char control[CMSG_SPACE(sizeof(int))];
	ssize_t length;
	struct cmsghdr *header;

	memset(&message, 0, sizeof(message));
	memset(control, 0, sizeof(control));
	vector.iov_base = shell_pid;
	vector.iov_len = sizeof(*shell_pid);
	message.msg_iov = &vector;
	message.msg_iovlen = 1;
	message.msg_control = control;
	message.msg_controllen = sizeof(control);
	length = recvmsg(socket_fd, &message, MSG_CMSG_CLOEXEC);
	if (length != (ssize_t)sizeof(*shell_pid) ||
	    (message.msg_flags & (MSG_TRUNC | MSG_CTRUNC)) != 0)
		return -1;
	header = CMSG_FIRSTHDR(&message);
	if (header == NULL || header->cmsg_level != SOL_SOCKET ||
	    header->cmsg_type != SCM_RIGHTS ||
	    header->cmsg_len != CMSG_LEN(sizeof(int)))
		return -1;
	memcpy(master_fd, CMSG_DATA(header), sizeof(*master_fd));
	return 0;
}

static void terminal_helper(struct labd_node *node, int channel,
			    unsigned int columns, unsigned int rows)
{
	struct namespace_fds fds;
	struct winsize size;
	int master = -1;
	int slave = -1;
	char slave_path[PATH_MAX];
	pid_t shell;
	int status;

	if (open_node_namespaces(node, &fds) < 0 ||
	    enter_node_namespaces(&fds, false) < 0 ||
	    chroot(node->root_dir) < 0 || chdir("/") < 0) {
		(void)send_terminal_descriptor(channel, -1, -1);
		_exit(125);
	}
	master = posix_openpt(O_RDWR | O_NOCTTY | O_CLOEXEC);
	if (master < 0 || grantpt(master) < 0 || unlockpt(master) < 0 ||
	    ptsname_r(master, slave_path, sizeof(slave_path)) != 0 ||
	    (slave = open(slave_path, O_RDWR | O_NOCTTY | O_CLOEXEC)) < 0 ||
	    setns(fds.pid_fd, CLONE_NEWPID) < 0) {
		(void)send_terminal_descriptor(channel, -1, -1);
		_exit(125);
	}
	memset(&size, 0, sizeof(size));
	size.ws_col = (unsigned short)columns;
	size.ws_row = (unsigned short)rows;
	(void)ioctl(slave, TIOCSWINSZ, &size);
	shell = fork();
	if (shell < 0) {
		(void)send_terminal_descriptor(channel, -1, -1);
		_exit(125);
	}
	if (shell == 0) {
		reset_child_signals();
		close(channel);
		close(master);
		(void)setsid();
		(void)ioctl(slave, TIOCSCTTY, 0);
		(void)dup2(slave, STDIN_FILENO);
		(void)dup2(slave, STDOUT_FILENO);
		(void)dup2(slave, STDERR_FILENO);
		if (slave > STDERR_FILENO)
			close(slave);
		if (clearenv() < 0)
			_exit(126);
		(void)setenv("PATH", "/usr/sbin:/usr/bin:/sbin:/bin", 1);
		(void)setenv("HOME", "/root", 1);
		(void)setenv("TERM", "xterm-256color", 1);
		(void)setenv("HOSTNAME", node->config.hostname, 1);
		if (access("/etc/anycastlab/pgo-generate", F_OK) == 0)
			(void)setenv("LLVM_PROFILE_FILE", "/dev/null", 1);
		if (chdir("/root") < 0 && chdir("/") < 0)
			_exit(126);
		execl("/bin/sh", "sh", "-i", (char *)NULL);
		_exit(127);
	}
	close_namespace_fds(&fds);
	close(slave);
	if (send_terminal_descriptor(channel, master, shell) < 0) {
		(void)kill(shell, SIGHUP);
		_exit(125);
	}
	close(master);
	close(channel);
	while (waitpid(shell, &status, 0) < 0 && errno == EINTR)
		;
	_exit(0);
}

static struct labd_terminal *find_terminal(unsigned long id,
					   unsigned long slot)
{
	for (size_t index = 0; index < LABD_MAX_TERMINALS; index++) {
		if (terminals[index].used && terminals[index].id == id &&
		    terminals[index].slot == slot)
			return &terminals[index];
	}
	return NULL;
}

static void close_terminal(struct labd_terminal *terminal)
{
	pid_t helper;
	pid_t shell;
	bool reaped = false;

	if (!terminal->used)
		return;
	helper = terminal->helper_pid;
	shell = terminal->shell_pid;
	if (shell > 0)
		(void)kill(shell, SIGHUP);
	if (terminal->master_fd >= 0)
		close(terminal->master_fd);
	if (helper > 0) {
		for (unsigned int attempt = 0; attempt < 20U; attempt++) {
			pid_t result = waitpid(helper, NULL, WNOHANG);

			if (result == helper || (result < 0 && errno == ECHILD)) {
				reaped = true;
				break;
			}
			if (result < 0 && errno != EINTR)
				break;
			struct timespec delay = { .tv_sec = 0, .tv_nsec = 50000000L };
			(void)nanosleep(&delay, NULL);
		}
		if (!reaped) {
			if (shell > 0)
				(void)kill(shell, SIGKILL);
			(void)kill(helper, SIGKILL);
			while (waitpid(helper, NULL, 0) < 0 && errno == EINTR)
				;
		}
	}
	memset(terminal, 0, sizeof(*terminal));
	terminal->master_fd = -1;
}

static void close_node_terminals(unsigned int slot)
{
	for (size_t index = 0; index < LABD_MAX_TERMINALS; index++) {
		if (terminals[index].used && terminals[index].slot == slot)
			close_terminal(&terminals[index]);
	}
}

static struct labd_terminal *open_terminal(struct labd_node *node,
					   unsigned int columns,
					   unsigned int rows,
					   struct labd_error *error)
{
	struct labd_terminal *terminal = NULL;
	int channels[2] = { -1, -1 };
	pid_t helper;
	int master = -1;
	pid_t shell = -1;

	for (size_t index = 0; index < LABD_MAX_TERMINALS; index++) {
		if (!terminals[index].used) {
			terminal = &terminals[index];
			break;
		}
	}
	if (terminal == NULL) {
		format_error(error, "terminal limit reached");
		errno = EMFILE;
		return NULL;
	}
	if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, channels) < 0) {
		format_error(error, "cannot create terminal descriptor channel: %s",
			     strerror(errno));
		return NULL;
	}
	helper = fork();
	if (helper < 0) {
		format_error(error, "cannot fork terminal helper: %s", strerror(errno));
		close(channels[0]);
		close(channels[1]);
		return NULL;
	}
	if (helper == 0) {
		close(channels[0]);
		terminal_helper(node, channels[1], columns, rows);
	}
	close(channels[1]);
	if (receive_terminal_descriptor(channels[0], &master, &shell) < 0 ||
	    master < 0 || shell <= 0) {
		format_error(error, "node terminal helper failed: %s", strerror(errno));
		close(channels[0]);
		(void)kill(helper, SIGKILL);
		while (waitpid(helper, NULL, 0) < 0 && errno == EINTR)
			;
		if (master >= 0)
			close(master);
		return NULL;
	}
	close(channels[0]);
	if (attach_cgroup(node, shell, error) < 0) {
		(void)kill(shell, SIGHUP);
		(void)kill(helper, SIGKILL);
		close(master);
		while (waitpid(helper, NULL, 0) < 0 && errno == EINTR)
			;
		return NULL;
	}
	(void)fcntl(master, F_SETFL, fcntl(master, F_GETFL) | O_NONBLOCK);
	terminal->used = true;
	terminal->id = next_terminal_id++;
	if (next_terminal_id == 0U)
		next_terminal_id = 1U;
	terminal->slot = node->config.slot;
	terminal->master_fd = master;
	terminal->helper_pid = helper;
	terminal->shell_pid = shell;
	terminal->columns = columns;
	terminal->rows = rows;
	return terminal;
}

static int open_node_path(struct labd_node *node, const char *path,
			  struct stat *metadata)
{
	char relative[PATH_MAX];
	char *cursor;
	int current;

	if (!labd_path_is_normalized_absolute(path) ||
	    strlen(path) >= sizeof(relative)) {
		errno = EINVAL;
		return -1;
	}
	memcpy(relative, path + 1, strlen(path));
	current = open(node->root_dir,
		       O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
	if (current < 0)
		return -1;
	cursor = relative;
	while (true) {
		char *slash = strchr(cursor, '/');
		int next;

		if (slash == NULL) {
			next = openat(current, cursor, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
			close(current);
			if (next < 0)
				return -1;
			if (fstat(next, metadata) < 0 || !S_ISREG(metadata->st_mode)) {
				close(next);
				errno = EINVAL;
				return -1;
			}
			return next;
		}
		*slash = '\0';
		next = openat(current, cursor,
			      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
		close(current);
		if (next < 0)
			return -1;
		current = next;
		cursor = slash + 1;
	}
}

static int tar_octal(unsigned char *field, size_t length, uint64_t value)
{
	char buffer[32];
	int digits = snprintf(buffer, sizeof(buffer), "%0*llo",
			      (int)length - 1, (unsigned long long)value);

	if (digits != (int)length - 1)
		return -1;
	memcpy(field, buffer, length - 1U);
	field[length - 1U] = 0;
	return 0;
}

static int split_tar_path(const char *path, char name[101], char prefix[156])
{
	const char *relative = path[0] == '/' ? path + 1 : path;
	size_t length = strlen(relative);

	memset(name, 0, 101U);
	memset(prefix, 0, 156U);
	if (length == 0U)
		return -1;
	if (length <= 100U) {
		memcpy(name, relative, length);
		return 0;
	}
	for (const char *slash = strrchr(relative, '/'); slash != NULL;
	     slash = slash == relative ? NULL :
		memrchr(relative, '/', (size_t)(slash - relative))) {
		size_t prefix_length = (size_t)(slash - relative);
		size_t name_length = length - prefix_length - 1U;

		if (prefix_length <= 155U && name_length > 0U && name_length <= 100U) {
			memcpy(prefix, relative, prefix_length);
			memcpy(name, slash + 1, name_length);
			return 0;
		}
	}
	return -1;
}

static int write_tar_entry(int output, const char *path, int input,
			   const struct stat *metadata, struct labd_error *error)
{
	unsigned char header[512];
	unsigned char padding[512] = { 0 };
	char name[101];
	char prefix[156];
	uint64_t checksum = 0;
	off_t remaining = metadata->st_size;
	unsigned char buffer[16384];

	if (metadata->st_size < 0 || metadata->st_size > 64 * 1024 * 1024 ||
	    split_tar_path(path, name, prefix) < 0) {
		format_error(error, "file cannot be represented in bounded ustar: %s", path);
		return -1;
	}
	memset(header, 0, sizeof(header));
	memcpy(header, name, strlen(name));
	if (tar_octal(header + 100U, 8U, metadata->st_mode & 0777U) < 0 ||
	    tar_octal(header + 108U, 8U, 0U) < 0 ||
	    tar_octal(header + 116U, 8U, 0U) < 0 ||
	    tar_octal(header + 124U, 12U, (uint64_t)metadata->st_size) < 0 ||
	    tar_octal(header + 136U, 12U, 0U) < 0) {
		format_error(error, "ustar numeric field overflow");
		return -1;
	}
	memset(header + 148U, ' ', 8U);
	header[156U] = '0';
	memcpy(header + 257U, "ustar\0", 6U);
	memcpy(header + 263U, "00", 2U);
	memcpy(header + 265U, "root", 4U);
	memcpy(header + 297U, "root", 4U);
	memcpy(header + 345U, prefix, strlen(prefix));
	for (size_t index = 0; index < sizeof(header); index++)
		checksum += header[index];
	char checksum_field[7];
	if (snprintf(checksum_field, sizeof(checksum_field), "%06llo",
		     (unsigned long long)checksum) != 6) {
		format_error(error, "ustar checksum overflow");
		return -1;
	}
	memcpy(header + 148U, checksum_field, 6U);
	header[154U] = 0;
	header[155U] = ' ';
	if (write_all(output, header, sizeof(header)) < 0) {
		format_error(error, "cannot write ustar header: %s", strerror(errno));
		return -1;
	}
	if (lseek(input, 0, SEEK_SET) < 0)
		return -1;
	while (remaining > 0) {
		size_t request = remaining < (off_t)sizeof(buffer) ?
			(size_t)remaining : sizeof(buffer);
		ssize_t received = read(input, buffer, request);

		if (received < 0 && errno == EINTR)
			continue;
		if (received <= 0 || write_all(output, buffer, (size_t)received) < 0) {
			format_error(error, "cannot stream ustar payload: %s", strerror(errno));
			return -1;
		}
		remaining -= received;
	}
	size_t padding_length = (512U - ((size_t)metadata->st_size & 511U)) & 511U;
	if (padding_length != 0U && write_all(output, padding, padding_length) < 0) {
		format_error(error, "cannot pad ustar payload: %s", strerror(errno));
		return -1;
	}
	return 0;
}

static int finish_tar_output(int descriptor, const char *temporary,
			     const char *destination, struct labd_error *error)
{
	unsigned char terminator[1024] = { 0 };

	if (write_all(descriptor, terminator, sizeof(terminator)) < 0 ||
	    fsync(descriptor) < 0 || close(descriptor) < 0) {
		format_error(error, "cannot finalize ustar output: %s", strerror(errno));
		(void)close(descriptor);
		(void)unlink(temporary);
		return -1;
	}
	if (rename(temporary, destination) < 0) {
		format_error(error, "cannot publish ustar output: %s", strerror(errno));
		(void)unlink(temporary);
		return -1;
	}
	sync();
	return 0;
}

static int apply_node_archive(struct labd_node *node, struct labd_error *error)
{
	char archive[PATH_MAX];
	int root_fd;
	int result;

	snprintf(archive, sizeof(archive), "%s/anycastlab-node-%u-in.tar",
		 LABD_HOST_MOUNT, node->config.slot);
	if (access(archive, F_OK) < 0) {
		format_error(error, "node input archive is missing: %s", strerror(errno));
		return -1;
	}
	root_fd = open(node->root_dir,
		       O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
	if (root_fd < 0) {
		format_error(error, "cannot open node root: %s", strerror(errno));
		return -1;
	}
	result = labd_extract_ustar(archive, root_fd, error);
	if (result == 0)
		(void)syncfs(root_fd);
	close(root_fd);
	return result;
}

static int export_node_file(struct labd_node *node, const char *path,
			    struct labd_error *error)
{
	char destination[PATH_MAX];
	char temporary[PATH_MAX + 32U];
	struct stat metadata;
	int input = open_node_path(node, path, &metadata);
	int output;

	if (input < 0) {
		format_error(error, "cannot read node file: %s", strerror(errno));
		return -1;
	}
	snprintf(destination, sizeof(destination),
		 "%s/anycastlab-node-%u-out.tar", LABD_HOST_MOUNT,
		 node->config.slot);
	snprintf(temporary, sizeof(temporary), "%s.tmp.%ld", destination,
		 (long)getpid());
	output = open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
	if (output < 0) {
		close(input);
		format_error(error, "cannot create file export: %s", strerror(errno));
		return -1;
	}
	if (write_tar_entry(output, path, input, &metadata, error) < 0) {
		close(input);
		close(output);
		unlink(temporary);
		return -1;
	}
	close(input);
	return finish_tar_output(output, temporary, destination, error);
}

struct pgo_file {
	char name[NAME_MAX + 1U];
	int descriptor;
	struct stat metadata;
};

static int compare_pgo_files(const void *left, const void *right)
{
	const struct pgo_file *first = left;
	const struct pgo_file *second = right;

	return strcmp(first->name, second->name);
}

static bool valid_pgo_name(const char *name, enum labd_kind kind)
{
	const char *prefix = kind == LABD_KIND_BIRD ? "daemon-bird_" : "daemon-frr_";
	size_t length = strlen(name);
	size_t prefix_length = strlen(prefix);
	static const char suffix[] = ".profraw";

	if (length <= prefix_length + sizeof(suffix) - 1U ||
	    strncmp(name, prefix, prefix_length) != 0 ||
	    strcmp(name + length - (sizeof(suffix) - 1U), suffix) != 0 ||
	    !isalnum((unsigned char)name[prefix_length]))
		return false;
	for (size_t index = prefix_length; index < length; index++) {
		unsigned char byte = (unsigned char)name[index];
		if (!(isalnum(byte) || byte == '.' || byte == '_' || byte == '-'))
			return false;
	}
	return true;
}

static int export_pgo_profiles(struct labd_node *node, struct labd_error *error)
{
	char directory_path[PATH_MAX];
	char destination[PATH_MAX];
	char temporary[PATH_MAX + 32U];
	struct pgo_file files[128];
	size_t count = 0;
	uint64_t total = 0;
	DIR *directory = NULL;
	int directory_fd = -1;
	int output = -1;
	int status = -1;

	memset(files, 0, sizeof(files));
	for (size_t index = 0; index < 128U; index++)
		files[index].descriptor = -1;
	if (node_path(directory_path, node, "/tmp/anycast-pgo") < 0)
		goto cleanup;
	directory_fd = open(directory_path,
			    O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
	if (directory_fd < 0 || (directory = fdopendir(dup(directory_fd))) == NULL) {
		format_error(error, "PGO profile directory is missing");
		goto cleanup;
	}
	errno = 0;
	while (true) {
		struct dirent *entry = readdir(directory);

		if (entry == NULL)
			break;
		if (entry->d_name[0] == '.')
			continue;
		if (!valid_pgo_name(entry->d_name, node->config.kind) || count == 128U) {
			format_error(error, "unexpected or excessive PGO profile file");
			goto cleanup;
		}
		files[count].descriptor = openat(directory_fd, entry->d_name,
					 O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
		if (files[count].descriptor < 0 ||
		    fstat(files[count].descriptor, &files[count].metadata) < 0 ||
		    !S_ISREG(files[count].metadata.st_mode) ||
		    files[count].metadata.st_size <= 0) {
			format_error(error, "unsafe or empty PGO profile file");
			goto cleanup;
		}
		total += (uint64_t)files[count].metadata.st_size;
		if (total > 64U * 1024U * 1024U) {
			format_error(error, "PGO profiles exceed 64 MiB");
			goto cleanup;
		}
		snprintf(files[count].name, sizeof(files[count].name), "%s",
			 entry->d_name);
		count++;
		errno = 0;
	}
	if (errno != 0 || count == 0U) {
		format_error(error, count == 0U ? "no PGO profiles were emitted" :
			     "cannot enumerate PGO profiles");
		goto cleanup;
	}
	qsort(files, count, sizeof(files[0]), compare_pgo_files);
	snprintf(destination, sizeof(destination),
		 "%s/anycastlab-node-%u-out.tar", LABD_HOST_MOUNT,
		 node->config.slot);
	snprintf(temporary, sizeof(temporary), "%s.tmp.%ld", destination,
		 (long)getpid());
	output = open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
	if (output < 0) {
		format_error(error, "cannot create PGO export: %s", strerror(errno));
		goto cleanup;
	}
	for (size_t index = 0; index < count; index++) {
		if (write_tar_entry(output, files[index].name, files[index].descriptor,
				    &files[index].metadata, error) < 0)
			goto cleanup;
	}
	if (finish_tar_output(output, temporary, destination, error) < 0) {
		output = -1;
		goto cleanup;
	}
	output = -1;
	status = 0;

cleanup:
	if (directory != NULL)
		closedir(directory);
	if (directory_fd >= 0)
		close(directory_fd);
	for (size_t index = 0; index < 128U; index++) {
		if (files[index].descriptor >= 0)
			close(files[index].descriptor);
	}
	if (output >= 0) {
		close(output);
		unlink(temporary);
	}
	return status;
}

static size_t control_tokens(char *line, char **tokens, size_t maximum)
{
	size_t count = 0;
	char *cursor = line;

	if (line[0] == '\0' || line[0] == ' ' ||
	    line[strlen(line) - 1U] == ' ' || strstr(line, "  ") != NULL)
		return maximum + 1U;
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

static char *decode_control_text(const char *encoded, size_t maximum,
				 struct labd_error *error)
{
	unsigned char *decoded = NULL;
	size_t length = 0;

	if (labd_base64_decode(encoded, &decoded, &length, maximum, error) < 0)
		return NULL;
	if (memchr(decoded, '\0', length) != NULL) {
		free(decoded);
		format_error(error, "decoded protocol field contains NUL");
		return NULL;
	}
	return (char *)decoded;
}

static const char *node_state_error(const struct labd_node *node)
{
	if (!node->configured)
		return "DELETED";
	if (!node->running)
		return "NOT_RUNNING";
	return NULL;
}

static int write_terminal_data(struct labd_terminal *terminal,
			       const unsigned char *data, size_t length)
{
	size_t offset = 0;

	while (offset < length) {
		ssize_t written = write(terminal->master_fd, data + offset,
					length - offset);

		if (written < 0 && errno == EINTR)
			continue;
		if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
			struct pollfd descriptor = {
				.fd = terminal->master_fd,
				.events = POLLOUT,
			};
			if (poll(&descriptor, 1U, 1000) <= 0)
				return -1;
			continue;
		}
		if (written <= 0)
			return -1;
		offset += (size_t)written;
	}
	return 0;
}

static void handle_control_line(char *line)
{
	char *tokens[8];
	size_t count = control_tokens(line, tokens,
				      sizeof(tokens) / sizeof(tokens[0]));
	unsigned long request_id;
	unsigned long slot;
	struct labd_node *node;
	struct labd_error error = { { 0 } };
	const char *state_error;

	if (count < 4U || count > sizeof(tokens) / sizeof(tokens[0]) ||
	    strcmp(tokens[0], LABD_PROTOCOL) != 0)
		return;
	if (!labd_canonical_positive(tokens[2], ULONG_MAX, &request_id))
		return;
	if (!labd_canonical_positive(tokens[3], LABD_MAX_NODES, &slot)) {
		response_error(request_id, "BAD_SLOT", NULL);
		return;
	}
	node = find_node(slot);
	if (node == NULL) {
		response_error(request_id, "BAD_SLOT", NULL);
		return;
	}

	if (strcmp(tokens[1], "PING") == 0) {
		if (count == 4U)
			response_ok(request_id, NULL);
		else
			response_error(request_id, "BAD_ARGUMENTS", NULL);
		return;
	}
	if (!node->configured) {
		response_error(request_id, "DELETED", NULL);
		return;
	}
	if (strcmp(tokens[1], "NODE_START") == 0) {
		if (count != 4U)
			response_error(request_id, "BAD_ARGUMENTS", NULL);
		else if (start_node(node, &error) < 0) {
			int saved_errno = errno;
			response_error(request_id,
				       saved_errno == EBUSY ? "EBUSY" : "START_FAILED",
				       error.message);
		} else
			response_ok(request_id, NULL);
		return;
	}
	if (strcmp(tokens[1], "NODE_STOP") == 0) {
		if (count != 4U)
			response_error(request_id, "BAD_ARGUMENTS", NULL);
		else {
			close_node_terminals(node->config.slot);
			if (stop_node(node, &error) < 0)
				response_error(request_id, "STOP_FAILED", error.message);
			else
				response_ok(request_id, NULL);
		}
		return;
	}
	if (strcmp(tokens[1], "NODE_DELETE") == 0) {
		if (count != 4U) {
			response_error(request_id, "BAD_ARGUMENTS", NULL);
			return;
		}
		close_node_terminals(node->config.slot);
		if (stop_node(node, &error) < 0) {
			response_error(request_id, "STOP_FAILED", error.message);
			return;
		}
		if (node->prepared && umount2(node->root_dir, MNT_DETACH) < 0) {
			response_error(request_id, "UNMOUNT_FAILED", strerror(errno));
			return;
		}
		node->prepared = false;
		if (node->runtime_mounted &&
		    umount2(node->runtime_dir, MNT_DETACH) < 0) {
			response_error(request_id, "UNMOUNT_FAILED", strerror(errno));
			return;
		}
		node->runtime_mounted = false;
		if (remove_runtime_directory(node) < 0) {
			response_error(request_id, "DELETE_FAILED", strerror(errno));
			return;
		}
		labd_free_node_config(&node->config);
		node->configured = false;
		response_ok(request_id, NULL);
		return;
	}

	if (strcmp(tokens[1], "APPLY") == 0) {
		enum labd_apply_disposition disposition = labd_apply_disposition(
			node->running, node->starting, node->namespace_alive);

		if (count != 4U)
			response_error(request_id, "BAD_ARGUMENTS", NULL);
		else if (disposition == LABD_APPLY_REJECT_TRANSITION)
			response_error(request_id, "NOT_RUNNING", NULL);
		else if (disposition == LABD_APPLY_PREPARE_ROOT &&
			 prepare_node_root(node, &error) < 0)
			response_error(request_id, "APPLY_FAILED", error.message);
		else if (apply_node_archive(node, &error) < 0) {
			int saved_errno = errno;
			response_error(request_id,
				       saved_errno == ENOENT ? "ENOENT" : "APPLY_FAILED",
				       error.message);
		} else
			response_ok(request_id, NULL);
		return;
	}

	state_error = node_state_error(node);
	if (state_error != NULL) {
		response_error(request_id, state_error, NULL);
		return;
	}
	if (strcmp(tokens[1], "READ") == 0) {
		char *path;

		if (count != 5U) {
			response_error(request_id, "BAD_ARGUMENTS", NULL);
			return;
		}
		path = decode_control_text(tokens[4], PATH_MAX - 1U, &error);
		if (path == NULL || !labd_path_is_normalized_absolute(path)) {
			response_error(request_id, "BAD_PATH", error.message);
			free(path);
			return;
		}
		if (export_node_file(node, path, &error) < 0) {
			int saved_errno = errno;
			response_error(request_id,
				       saved_errno == ENOENT ? "ENOENT" : "READ_FAILED",
				       error.message);
		} else
			response_ok(request_id, NULL);
		free(path);
		return;
	}
	if (strcmp(tokens[1], "LINK") == 0) {
		char *name;
		bool found = false;

		if (count != 6U ||
		    (strcmp(tokens[5], "up") != 0 && strcmp(tokens[5], "down") != 0)) {
			response_error(request_id, "BAD_ARGUMENTS", NULL);
			return;
		}
		name = decode_control_text(tokens[4], IFNAMSIZ - 1U, &error);
		if (name == NULL) {
			response_error(request_id, "BAD_INTERFACE", error.message);
			return;
		}
		for (size_t index = 0; index < node->config.interface_count; index++) {
			if (strcmp(name, node->config.interfaces[index].name) == 0) {
				found = true;
				break;
			}
		}
		if (!found)
			response_error(request_id, "BAD_INTERFACE", NULL);
		else if (set_node_link(node, name, strcmp(tokens[5], "up") == 0,
				       &error) < 0)
			response_error(request_id, "LINK_FAILED", error.message);
		else
			response_ok(request_id, NULL);
		free(name);
		return;
	}
	if (strcmp(tokens[1], "TERM_OPEN") == 0) {
		unsigned long columns;
		unsigned long rows;
		struct labd_terminal *terminal;
		char detail[32];

		if (count != 6U ||
		    !labd_canonical_positive(tokens[4], USHRT_MAX, &columns) ||
		    !labd_canonical_positive(tokens[5], USHRT_MAX, &rows)) {
			response_error(request_id, "BAD_ARGUMENTS", NULL);
			return;
		}
		terminal = open_terminal(node, (unsigned int)columns,
					 (unsigned int)rows, &error);
		if (terminal == NULL)
			response_error(request_id, "TERM_OPEN_FAILED", error.message);
		else {
			snprintf(detail, sizeof(detail), "%u", terminal->id);
			response_ok(request_id, detail);
		}
		return;
	}
	if (strcmp(tokens[1], "TERM_WRITE") == 0) {
		unsigned long terminal_id;
		struct labd_terminal *terminal;
		unsigned char *data = NULL;
		size_t length = 0;

		if (count != 6U ||
		    !labd_canonical_positive(tokens[4], UINT_MAX, &terminal_id) ||
		    labd_base64_decode(tokens[5], &data, &length,
				       LABD_MAX_TERMINAL_CHUNK, &error) < 0) {
			response_error(request_id, "BAD_ARGUMENTS", error.message);
			free(data);
			return;
		}
		terminal = find_terminal(terminal_id, slot);
		if (terminal == NULL)
			response_error(request_id, "BAD_TERMINAL", NULL);
		else if (write_terminal_data(terminal, data, length) < 0)
			response_error(request_id, "TERM_WRITE_FAILED", strerror(errno));
		else
			response_ok(request_id, NULL);
		free(data);
		return;
	}
	if (strcmp(tokens[1], "TERM_RESIZE") == 0) {
		unsigned long terminal_id;
		unsigned long columns;
		unsigned long rows;
		struct labd_terminal *terminal;
		struct winsize size;

		if (count != 7U ||
		    !labd_canonical_positive(tokens[4], UINT_MAX, &terminal_id) ||
		    !labd_canonical_positive(tokens[5], USHRT_MAX, &columns) ||
		    !labd_canonical_positive(tokens[6], USHRT_MAX, &rows)) {
			response_error(request_id, "BAD_ARGUMENTS", NULL);
			return;
		}
		terminal = find_terminal(terminal_id, slot);
		if (terminal == NULL) {
			response_error(request_id, "BAD_TERMINAL", NULL);
			return;
		}
		memset(&size, 0, sizeof(size));
		size.ws_col = (unsigned short)columns;
		size.ws_row = (unsigned short)rows;
		if (ioctl(terminal->master_fd, TIOCSWINSZ, &size) < 0)
			response_error(request_id, "TERM_RESIZE_FAILED", strerror(errno));
		else {
			terminal->columns = (unsigned int)columns;
			terminal->rows = (unsigned int)rows;
			response_ok(request_id, NULL);
		}
		return;
	}
	if (strcmp(tokens[1], "TERM_CLOSE") == 0) {
		unsigned long terminal_id;
		struct labd_terminal *terminal;

		if (count != 5U ||
		    !labd_canonical_positive(tokens[4], UINT_MAX, &terminal_id)) {
			response_error(request_id, "BAD_ARGUMENTS", NULL);
			return;
		}
		terminal = find_terminal(terminal_id, slot);
		if (terminal == NULL)
			response_error(request_id, "BAD_TERMINAL", NULL);
		else {
			close_terminal(terminal);
			response_ok(request_id, NULL);
		}
		return;
	}
	if (strcmp(tokens[1], "COLLECT_PGO") == 0) {
		char marker[PATH_MAX];

		if (count != 4U || node->config.kind == LABD_KIND_CLIENT) {
			response_error(request_id, "PGO_UNSUPPORTED", NULL);
			return;
		}
		if (node_path(marker, node, "/etc/anycastlab/pgo-generate") < 0 ||
		    access(marker, F_OK) < 0) {
			response_error(request_id, "PGO_NOT_INSTRUMENTED", NULL);
			return;
		}
		close_node_terminals(node->config.slot);
		/* Profile runtime finalizers may take materially longer than a normal
		 * interactive stop. Match the former 150-second collector window before
		 * permitting the namespace supervisor to escalate to SIGKILL. */
		if (stop_node_with_grace(node, 1500U, &error) < 0)
			response_error(request_id, "PGO_STOP_FAILED", error.message);
		else if (export_pgo_profiles(node, &error) < 0)
			response_error(request_id, "PGO_EXPORT_FAILED", error.message);
		else
			response_ok(request_id, NULL);
		return;
	}
	response_error(request_id, "UNKNOWN_COMMAND", NULL);
}

static void report_node_exit(struct labd_node *node, const char *reason)
{
	char *encoded;

	if (node->stopping || node->exit_reported)
		return;
	encoded = labd_base64_encode((const unsigned char *)reason, strlen(reason));
	if (encoded != NULL) {
		protocol_line(LABD_PROTOCOL " NODE_EXIT %u %s\n",
			      node->config.slot, encoded);
		free(encoded);
	}
	node->exit_reported = true;
}

static void process_node_event(struct labd_node *node)
{
	while (true) {
		struct node_event event;
		ssize_t length = recv(node->event_fd, &event, sizeof(event), MSG_DONTWAIT);

		if (length < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))
			return;
		if (length != (ssize_t)sizeof(event))
			return;
		event.detail[sizeof(event.detail) - 1U] = '\0';
		if (event.type == EVENT_READY) {
			node->starting = false;
			node->running = true;
			protocol_line(LABD_PROTOCOL " NODE_READY %u\n", node->config.slot);
		} else if (event.type == SETUP_ERROR) {
			node->starting = false;
			node->running = false;
			protocol_log(node->config.slot, "error",
				event.detail[0] == '\0' ? "namespace setup failed" : event.detail);
			report_node_exit(node, event.detail[0] == '\0' ?
					 "namespace setup failed" : event.detail);
		} else if (event.type == EVENT_EXIT) {
			node->starting = false;
			node->running = false;
			report_node_exit(node, event.detail[0] == '\0' ?
					 "entrypoint exited" : event.detail);
		}
	}
}

static void process_terminal_output(struct labd_terminal *terminal)
{
	unsigned char buffer[LABD_MAX_TERMINAL_CHUNK];
	ssize_t length = read(terminal->master_fd, buffer, sizeof(buffer));

	if (length > 0) {
		char *encoded = labd_base64_encode(buffer, (size_t)length);

		if (encoded != NULL) {
			protocol_line(LABD_PROTOCOL " TERM_DATA %u %u %s\n",
				      terminal->slot, terminal->id, encoded);
			free(encoded);
		}
		return;
	}
	if (length == 0 || (length < 0 && errno != EAGAIN && errno != EWOULDBLOCK &&
				       errno != EINTR))
		close_terminal(terminal);
}

static void reap_children(void)
{
	for (size_t index = 0; index < node_count; index++) {
		struct labd_node *node = &nodes[index];

		if (!node->namespace_alive)
			continue;
		process_node_event(node);
		pid_t result = waitpid(node->launcher_pid, NULL, WNOHANG);
		if (result == node->launcher_pid || (result < 0 && errno == ECHILD)) {
			if (!node->stopping && !node->exit_reported)
				report_node_exit(node, "node namespace exited without a final event");
			cleanup_node_process(node);
		}
	}
	for (size_t index = 0; index < LABD_MAX_TERMINALS; index++) {
		struct labd_terminal *terminal = &terminals[index];
		if (!terminal->used || terminal->helper_pid <= 0)
			continue;
		pid_t result = waitpid(terminal->helper_pid, NULL, WNOHANG);
		if (result == terminal->helper_pid || (result < 0 && errno == ECHILD))
			close_terminal(terminal);
	}
}

static int consume_control_input(char *buffer, size_t *used)
{
	unsigned char input[4096];
	ssize_t length = read(control_fd, input, sizeof(input));

	if (length < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR))
		return 0;
	if (length <= 0)
		return -1;
	for (ssize_t index = 0; index < length; index++) {
		unsigned char byte = input[index];

		if (byte == '\r' || byte == '\0')
			return -1;
		if (byte == '\n') {
			buffer[*used] = '\0';
			if (*used != 0U)
				handle_control_line(buffer);
			*used = 0U;
			continue;
		}
		if (*used == LABD_MAX_CONTROL_LINE)
			return -1;
		buffer[(*used)++] = (char)byte;
	}
	return 0;
}

static int prepare_signal_fd(void)
{
	sigset_t mask;

	sigemptyset(&mask);
	sigaddset(&mask, SIGCHLD);
	sigaddset(&mask, SIGTERM);
	sigaddset(&mask, SIGINT);
	sigaddset(&mask, SIGHUP);
	if (sigprocmask(SIG_BLOCK, &mask, NULL) < 0)
		return -1;
	return signalfd(-1, &mask, SFD_CLOEXEC | SFD_NONBLOCK);
}

static int prepare_control_device(void)
{
	struct termios terminal;
	int descriptor = open("/dev/hvc0", O_RDWR | O_NOCTTY | O_CLOEXEC |
			      O_NONBLOCK);

	if (descriptor < 0)
		return -1;
	if (tcgetattr(descriptor, &terminal) == 0) {
		cfmakeraw(&terminal);
		(void)tcsetattr(descriptor, TCSANOW, &terminal);
	}
	return descriptor;
}

static int ensure_cgroup_hierarchy(struct labd_error *error)
{
	if (access("/sys/fs/cgroup/cgroup.controllers", R_OK) == 0)
		return 0;
	if (mkdir_parents("/sys/fs/cgroup", 0755) < 0 ||
	    mount("none", "/sys/fs/cgroup", "cgroup2",
		  MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL) < 0) {
		format_error(error, "cannot mount cgroup v2: %s", strerror(errno));
		return -1;
	}
	return 0;
}

static int extract_bootstrap(struct labd_error *error)
{
	int root_fd;
	int result;

	if (mkdir_parents("/run/anycastlab", 0700) < 0) {
		format_error(error, "cannot create bootstrap runtime: %s", strerror(errno));
		return -1;
	}
	root_fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
	if (root_fd < 0) {
		format_error(error, "cannot open guest root: %s", strerror(errno));
		return -1;
	}
	result = labd_extract_ustar(LABD_BOOTSTRAP_ARCHIVE, root_fd, error);
	close(root_fd);
	return result;
}

static void shutdown_nodes(void)
{
	struct labd_error error;

	for (size_t index = 0; index < LABD_MAX_TERMINALS; index++)
		close_terminal(&terminals[index]);
	for (size_t index = 0; index < node_count; index++) {
		memset(&error, 0, sizeof(error));
		(void)stop_node(&nodes[index], &error);
		if (nodes[index].prepared) {
			(void)umount2(nodes[index].root_dir, MNT_DETACH);
			nodes[index].prepared = false;
		}
		if (nodes[index].runtime_mounted) {
			(void)umount2(nodes[index].runtime_dir, MNT_DETACH);
			nodes[index].runtime_mounted = false;
		}
		if (nodes[index].configured)
			labd_free_node_config(&nodes[index].config);
	}
	(void)umount2(LABD_BASE_ROOT, MNT_DETACH);
}

static void drain_control_output(void)
{
	for (unsigned int attempt = 0;
	     attempt < 20U && labd_output_pending(&control_output) > 0U;
	     attempt++) {
		struct pollfd descriptor = {
			.fd = control_fd,
			.events = POLLOUT,
		};
		int result;

		if (labd_output_flush(&control_output, control_fd,
				      control_write, NULL) < 0 ||
		    labd_output_pending(&control_output) == 0U)
			return;
		result = poll(&descriptor, 1U, 50);
		if (result < 0 && errno == EINTR)
			continue;
		if (result <= 0 ||
		    (descriptor.revents & (POLLERR | POLLHUP | POLLNVAL)) != 0)
			return;
	}
}

int main(void)
{
	struct labd_error error = { { 0 } };
	char *control_buffer = NULL;
	size_t control_used = 0;
	bool shutting_down = false;
	bool loop_failed = false;
	int exit_status = EXIT_FAILURE;

	labd_output_init(&control_output);
	for (size_t index = 0; index < LABD_MAX_TERMINALS; index++)
		terminals[index].master_fd = -1;
	control_fd = prepare_control_device();
	if (control_fd < 0) {
		fprintf(stderr, "anycast-labd: cannot open /dev/hvc0: %s\n",
			strerror(errno));
		goto cleanup;
	}
	if (extract_bootstrap(&error) < 0 || load_bootstrap(&error) < 0 ||
	    ensure_cgroup_hierarchy(&error) < 0 || prepare_cgroup_root(&error) < 0 ||
	    prepare_base_root(&error) < 0) {
		protocol_log(1U, "error", error.message);
		fprintf(stderr, "anycast-labd: %s\n", error.message);
		goto cleanup;
	}
	signal_fd = prepare_signal_fd();
	if (signal_fd < 0) {
		fprintf(stderr, "anycast-labd: cannot create signal fd: %s\n",
			strerror(errno));
		goto cleanup;
	}
	control_buffer = malloc(LABD_MAX_CONTROL_LINE + 1U);
	if (control_buffer == NULL)
		goto cleanup;
	protocol_line(LABD_PROTOCOL " READY\n");

	while (!shutting_down) {
		struct pollfd descriptors[2U + LABD_MAX_NODES + LABD_MAX_TERMINALS];
		unsigned char kinds[2U + LABD_MAX_NODES + LABD_MAX_TERMINALS];
		unsigned short indexes[2U + LABD_MAX_NODES + LABD_MAX_TERMINALS];
		nfds_t count = 0;
		bool output_pending = labd_output_pending(&control_output) > 0U;

		descriptors[count] = (struct pollfd) {
			.fd = control_fd,
			.events = output_pending ? POLLOUT : POLLIN,
		};
		kinds[count] = 1U;
		indexes[count++] = 0U;
		if (!output_pending) {
			for (size_t index = 0; index < node_count; index++) {
				if (nodes[index].event_fd < 0)
					continue;
				descriptors[count] = (struct pollfd) {
					.fd = nodes[index].event_fd,
					.events = POLLIN | POLLHUP,
				};
				kinds[count] = 2U;
				indexes[count++] = (unsigned short)index;
			}
			for (size_t index = 0; index < LABD_MAX_TERMINALS; index++) {
				if (!terminals[index].used)
					continue;
				descriptors[count] = (struct pollfd) {
					.fd = terminals[index].master_fd,
					.events = POLLIN | POLLHUP,
				};
				kinds[count] = 3U;
				indexes[count++] = (unsigned short)index;
			}
		}
		descriptors[count] = (struct pollfd) { .fd = signal_fd, .events = POLLIN };
		kinds[count] = 4U;
		indexes[count++] = 0U;

		if (poll(descriptors, count, -1) < 0) {
			if (errno == EINTR)
				continue;
			loop_failed = true;
			break;
		}
		for (nfds_t index = 0; index < count; index++) {
			if (descriptors[index].revents == 0)
				continue;
			if (kinds[index] == 1U) {
				if ((descriptors[index].revents &
				     (POLLERR | POLLHUP | POLLNVAL)) != 0) {
					shutting_down = true;
				} else if ((descriptors[index].revents & POLLOUT) != 0) {
					if (flush_control_output() < 0)
						shutting_down = true;
				} else if ((descriptors[index].revents & POLLIN) != 0 &&
					   consume_control_input(control_buffer,
								 &control_used) < 0) {
					shutting_down = true;
				}
			} else if (kinds[index] == 2U) {
				if (labd_output_pending(&control_output) == 0U)
					process_node_event(&nodes[indexes[index]]);
			} else if (kinds[index] == 3U) {
				if (labd_output_pending(&control_output) == 0U)
					process_terminal_output(&terminals[indexes[index]]);
			} else {
				struct signalfd_siginfo information;
				while (read(signal_fd, &information, sizeof(information)) ==
				       (ssize_t)sizeof(information)) {
					if (information.ssi_signo == SIGCHLD)
						reap_children();
					else
						shutting_down = true;
				}
			}
			if (control_output_failed)
				shutting_down = true;
		}
	}
	if (!loop_failed && !control_output_failed)
		exit_status = EXIT_SUCCESS;

cleanup:
	if (control_fd >= 0)
		drain_control_output();
	shutdown_nodes();
	free(control_buffer);
	if (signal_fd >= 0)
		close(signal_fd);
	if (control_fd >= 0)
		close(control_fd);
	return exit_status;
}
