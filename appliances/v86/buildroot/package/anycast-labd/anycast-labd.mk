################################################################################
#
# anycast-labd
#
################################################################################

ANYCAST_LABD_VERSION = 1
ANYCAST_LABD_SITE = $(BR2_EXTERNAL_ANYCAST_LAB_PATH)/package/anycast-labd/src
ANYCAST_LABD_SITE_METHOD = local
ANYCAST_LABD_LICENSE = AGPL-3.0-or-later

define ANYCAST_LABD_BUILD_CMDS
	$(TARGET_CC) $(TARGET_CFLAGS) -std=c11 \
		-Wall -Wextra -Werror -Wformat=2 -Wshadow \
		$(TARGET_LDFLAGS) -o $(@D)/anycast-labd \
		$(@D)/labd.c $(@D)/config.c $(@D)/archive.c $(@D)/protocol.c
endef

define ANYCAST_LABD_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 0755 $(@D)/anycast-labd \
		$(TARGET_DIR)/usr/sbin/anycast-labd
endef

$(eval $(generic-package))
