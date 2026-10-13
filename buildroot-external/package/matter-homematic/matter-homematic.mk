################################################################################
#
# Matter-Homematic Bridge (CCU3-neu) - Matter/Apple Home fuer Homematic/HmIP, fest im Systemabbild
#
################################################################################

MATTER_HOMEMATIC_VERSION = local
MATTER_HOMEMATIC_SITE = $(MATTER_HOMEMATIC_PKGDIR)/src
MATTER_HOMEMATIC_SITE_METHOD = local
MATTER_HOMEMATIC_LICENSE = Proprietary (CCU3-neu), third-party components see THIRD-PARTY-LICENSES.txt
MATTER_HOMEMATIC_LICENSE_FILES = THIRD-PARTY-LICENSES.txt
MATTER_HOMEMATIC_DEPENDENCIES = nodejs

# Programm read-only nach /usr/lib/matter-homematic (Daten bleiben in /usr/local/etc/config/addons/matter-homematic).
# Das gebuendelte node des Add-ons entfaellt: es wird das node des Abbilds (/usr/bin/node) verwendet.
define MATTER_HOMEMATIC_INSTALL_TARGET_CMDS
	rm -rf $(TARGET_DIR)/usr/lib/matter-homematic
	mkdir -p $(TARGET_DIR)/usr/lib/matter-homematic
	cp -a $(@D)/dist $(@D)/html $(@D)/vendor $(TARGET_DIR)/usr/lib/matter-homematic/
	$(INSTALL) -m 0644 $(@D)/package.json $(@D)/VERSION $(@D)/config.example.json \
		$(@D)/THIRD-PARTY-LICENSES.txt $(@D)/DISTRIBUTION-SBOM.json $(@D)/RUNTIME-PROVENANCE.json \
		$(@D)/JEEP-UPSTREAM-LICENSE.txt $(@D)/JEEP-UPSTREAM-NOTICE.txt $(TARGET_DIR)/usr/lib/matter-homematic/
	$(INSTALL) -D -m 0644 $(MATTER_HOMEMATIC_PKGDIR)/matter-homematic.monit $(TARGET_DIR)/etc/monit.d/matter-homematic.cfg
	$(INSTALL) -D -m 0644 $(MATTER_HOMEMATIC_PKGDIR)/netzspeicher.monit $(TARGET_DIR)/etc/monit.d/netzspeicher.cfg
endef

define MATTER_HOMEMATIC_INSTALL_INIT_SYSV
	$(INSTALL) -D -m 0755 $(MATTER_HOMEMATIC_PKGDIR)/S97matter-homematic \
		$(TARGET_DIR)/etc/init.d/S97matter-homematic
	$(INSTALL) -D -m 0755 $(MATTER_HOMEMATIC_PKGDIR)/S96netzspeicher \
		$(TARGET_DIR)/etc/init.d/S96netzspeicher
endef

# Reste der alten Weboberflaeche aus dem Abbild entfernen (nach der Installation aller Pakete)
define MATTER_HOMEMATIC_REMOVE_OLD_UI
	sh $(MATTER_HOMEMATIC_PKGDIR)/remove-old-ui.sh $(TARGET_DIR) $(MATTER_HOMEMATIC_PKGDIR)/ccu3-neu-startet.html
endef
TARGET_FINALIZE_HOOKS += MATTER_HOMEMATIC_REMOVE_OLD_UI

$(eval $(generic-package))
