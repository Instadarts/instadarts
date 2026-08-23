import { useState } from 'react';
import {
  ActionIcon,
  AppShell,
  Badge,
  Box,
  Button,
  Card,
  Divider,
  Group,
  Indicator,
  Menu,
  Modal,
  SimpleGrid,
  Stack,
  Switch,
  Text,
} from '@mantine/core';
import type { DeviceView, PairingCode } from '../hooks/useScoringDevices';
import { FullscreenButton } from './FullscreenButton';
import { CameraIcon, SettingsIcon } from './AppIcons';
import { PairDeviceDialog } from './PairDeviceDialog';
import { useLayoutEditor } from '../layout/LayoutEditorContext';
import {
  applyAppZoom,
  APP_ZOOM_STEP,
  loadAppZoom,
  MAX_APP_ZOOM,
  MIN_APP_ZOOM,
  saveAppZoom,
} from '../layout/appZoom';

interface TopBarProps {
  connected: boolean;
  devices: DeviceView[];
  pairing: boolean;
  pairingCode: PairingCode | null;
  onStartPairing: () => void;
  onRequestPairingCode: () => void;
  onCancelPairing: () => void;
  onGrab: (deviceId: string) => void;
  onRelease: (deviceId: string) => void;
  onForget: (deviceId: string) => void;
  onSetCamera: (deviceId: string, active: boolean) => void;
  onPowerOff: (deviceId: string) => void;
  media: boolean | null;
  onMediaChange: (enabled: boolean) => void;
  boardCamera: string | null;
  onBoardCameraChange: (deviceId: string | null) => void;
}

export function TopBar({
  connected,
  devices,
  pairing,
  pairingCode,
  onStartPairing,
  onRequestPairingCode,
  onCancelPairing,
  onGrab,
  onRelease,
  onForget,
  onSetCamera,
  onPowerOff,
  media,
  onMediaChange,
  boardCamera,
  onBoardCameraChange,
}: TopBarProps) {
  const editor = useLayoutEditor();
  const [frontendZoom, setFrontendZoom] = useState(() => loadAppZoom('frontend'));
  const scoring = devices.filter((device) => device.active && device.online).length;
  const camerasLabel = scoring > 0 ? `Cameras · ${scoring}` : 'Cameras';
  const connectionLabel = connected ? 'Connected' : 'Waiting for server…';
  const changeFrontendZoom = (change: number) => {
    setFrontendZoom((current) => {
      const next = saveAppZoom('frontend', current + change);
      applyAppZoom('frontend', next);
      return next;
    });
  };

  return (
    <>
      <AppShell.Header bg="dark.8" withBorder>
        <Group h="100%" px="md" justify="space-between" gap="sm" wrap="nowrap">
          <Text fw={800} c="green.4" fz="lg" truncate>InstaDarts</Text>

          <Group gap="xs" wrap="nowrap">
            <Group
              gap={6}
              wrap="nowrap"
              role="status"
              aria-label={connectionLabel}
              title={connectionLabel}
            >
              <Text
                visibleFrom="sm"
                w="8.75rem"
                fz="sm"
                c={connected ? 'green.4' : 'yellow.4'}
                ta="right"
                truncate
              >
                {connectionLabel}
              </Text>
              <Indicator
                color={connected ? 'green' : 'yellow'}
                processing={!connected}
                size={9}
                position="middle-center"
              >
                <Box w={10} h={10} aria-hidden />
              </Indicator>
            </Group>

            <FullscreenButton />

            <Menu position="bottom-end" withinPortal shadow="xl" closeOnItemClick={false}>
              <Menu.Target>
                <ActionIcon
                  variant={scoring > 0 ? 'light' : 'default'}
                  color="green"
                  size="lg"
                  title={camerasLabel}
                  aria-label={camerasLabel}
                >
                  <CameraIcon />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown
                w="min(30rem, calc(100vw - 1rem))"
                mah="calc(100dvh - 5rem)"
                style={{ overflowY: 'auto' }}
              >
                <Stack gap="sm" p="xs">
                  <Group justify="space-between" align="center" wrap="nowrap">
                    <Button size="xs" onClick={onStartPairing} disabled={!connected || pairing}>
                      Pair scoring device
                    </Button>
                    {media !== null && (
                      <Switch
                        label="Live video"
                        checked={media}
                        onChange={(event) => onMediaChange(event.currentTarget.checked)}
                      />
                    )}
                  </Group>

                  {devices.length === 0 && (
                    <Text fz="sm" c="dimmed">No scoring devices paired to this browser yet.</Text>
                  )}

                  <SimpleGrid minColWidth={230} spacing="sm">
                    {devices.map((device) => (
                      <DeviceBox
                        key={device.deviceId}
                        device={device}
                        boardCamera={media ? boardCamera : null}
                        showBoardCamera={media !== null}
                        onBoardCameraChange={(on) => onBoardCameraChange(on ? device.deviceId : null)}
                        onGrab={() => onGrab(device.deviceId)}
                        onRelease={() => onRelease(device.deviceId)}
                        onForget={() => onForget(device.deviceId)}
                        onSetCamera={(active) => onSetCamera(device.deviceId, active)}
                        onPowerOff={() => onPowerOff(device.deviceId)}
                      />
                    ))}
                  </SimpleGrid>
                </Stack>
              </Menu.Dropdown>
            </Menu>

            <Menu position="bottom-end" withinPortal shadow="md">
              <Menu.Target>
                <ActionIcon
                  variant={editor.editing ? 'light' : 'default'}
                  color={editor.editing ? 'green' : 'gray'}
                  size="lg"
                  title="Settings"
                  aria-label="Settings"
                >
                  <SettingsIcon />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown miw={230}>
                <Menu.Label>
                  Layout
                </Menu.Label>
                <Box px="sm" py="xs">
                  <Stack gap="sm">
                    <Group justify="space-between" gap="md" wrap="nowrap">
                      <Text fz="sm">Zoom</Text>
                      <Group gap={6} wrap="nowrap">
                        <ActionIcon
                          variant="default"
                          size="sm"
                          aria-label="Increase zoom"
                          title="Increase zoom"
                          disabled={frontendZoom >= MAX_APP_ZOOM}
                          onClick={() => changeFrontendZoom(APP_ZOOM_STEP)}
                        >
                          +
                        </ActionIcon>
                        <Text fz="sm" fw={600} ta="center" w="3rem" ff="monospace">
                          {frontendZoom}%
                        </Text>
                        <ActionIcon
                          variant="default"
                          size="sm"
                          aria-label="Decrease zoom"
                          title="Decrease zoom"
                          disabled={frontendZoom <= MIN_APP_ZOOM}
                          onClick={() => changeFrontendZoom(-APP_ZOOM_STEP)}
                        >
                          −
                        </ActionIcon>
                      </Group>
                    </Group>
                    {editor.active && (
                      <Group justify="space-between" gap="sm" align="flex-start" wrap="nowrap">
                        <Switch
                          label="Edit Match Layout"
                          description="Drag box headers and resize corners"
                          checked={editor.editing}
                          onChange={(event) => editor.setEditing(event.currentTarget.checked)}
                          style={{ flex: 1 }}
                        />
                        <Badge variant="light" size="sm" mt={2}>{editor.active.breakpoint}</Badge>
                      </Group>
                    )}
                  </Stack>
                </Box>
                {editor.active && (
                  <Menu.Item color="red" onClick={editor.reset}>Reset layout</Menu.Item>
                )}
                <Menu.Divider />
                <Menu.Label>Links</Menu.Label>
                <Menu.Item
                  component="a"
                  href="https://github.com/Instadarts"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Source code
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </AppShell.Header>

      <Modal opened={pairing} onClose={onCancelPairing} title="Pair scoring device" centered size="sm">
        <PairDeviceDialog code={pairingCode} onRequest={onRequestPairingCode} onCancel={onCancelPairing} />
      </Modal>
    </>
  );
}

interface DeviceBoxProps {
  device: DeviceView;
  boardCamera: string | null;
  showBoardCamera: boolean;
  onBoardCameraChange: (on: boolean) => void;
  onGrab: () => void;
  onRelease: () => void;
  onForget: () => void;
  onSetCamera: (active: boolean) => void;
  onPowerOff: () => void;
}

function DeviceBox({
  device,
  boardCamera,
  showBoardCamera,
  onBoardCameraChange,
  onGrab,
  onRelease,
  onForget,
  onSetCamera,
  onPowerOff,
}: DeviceBoxProps) {
  const [confirmingPowerOff, setConfirmingPowerOff] = useState(false);
  const reachable = device.active && device.online;
  const offered = device.media !== 'disabled';

  return (
    <Card withBorder bg="dark.9" padding="sm">
      <Stack gap="xs">
        <Group justify="space-between" gap="xs" wrap="nowrap">
          <Group gap="xs" wrap="nowrap" miw={0}>
            <Box w={8} h={8} bg={statusColor(device)} style={{ borderRadius: '50%', flexShrink: 0 }} />
            <Text fz="sm" truncate data-testid="device-name">{device.name}</Text>
          </Group>
          <Text fz="xs" c="dimmed" style={{ flexShrink: 0 }} data-testid="device-status">
            {statusLabel(device)}
          </Text>
        </Group>

        <Group gap="xs">
          {reachable && (
            <Button
              size="compact-xs"
              variant="default"
              onClick={() => onSetCamera(!device.cameraActive)}
              disabled={device.cameraPending}
            >
              {device.cameraPending ? '…' : device.cameraActive ? 'Camera off' : 'Camera on'}
            </Button>
          )}
          <Button size="compact-xs" variant={device.active ? 'default' : 'light'} onClick={device.active ? onRelease : onGrab}>
            {device.active ? 'Release' : 'Use here'}
          </Button>
          <Button size="compact-xs" variant="subtle" color="gray" onClick={onForget}>Forget</Button>
        </Group>

        {device.cameraError && <Text fz="xs" c="yellow.5">{device.cameraError}</Text>}

        {showBoardCamera && reachable && (
          <Switch
            label="Board camera"
            description={!offered ? 'This device is not sharing its view' : device.media === 'stills' ? 'Stills only' : undefined}
            checked={boardCamera === device.deviceId}
            disabled={!offered}
            onChange={(event) => onBoardCameraChange(event.currentTarget.checked)}
          />
        )}

        {reachable && (
          <>
            <Divider />
            {confirmingPowerOff ? (
              <Stack gap="xs">
                <Text fz="xs" c="dimmed">It will disconnect until somebody wakes it at the board.</Text>
                <Group gap="xs" justify="flex-end">
                  <Button size="compact-xs" variant="default" onClick={() => setConfirmingPowerOff(false)}>Cancel</Button>
                  <Button
                    size="compact-xs"
                    color="red"
                    onClick={() => { setConfirmingPowerOff(false); onPowerOff(); }}
                  >
                    Power off
                  </Button>
                </Group>
              </Stack>
            ) : (
              <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setConfirmingPowerOff(true)}>
                Power off
              </Button>
            )}
          </>
        )}
      </Stack>
    </Card>
  );
}

function statusColor(device: DeviceView): string {
  if (!device.active) return 'var(--mantine-color-gray-6)';
  if (device.cameraActive) return 'var(--mantine-color-green-5)';
  if (device.online) return 'var(--mantine-color-blue-5)';
  return 'var(--mantine-color-gray-6)';
}

function statusLabel(device: DeviceView): string {
  if (device.poweredOff) return 'powered off';
  if (!device.active) return 'not in use here';
  if (device.cameraActive) return 'camera on';
  if (device.online) return 'connected';
  return 'offline';
}
