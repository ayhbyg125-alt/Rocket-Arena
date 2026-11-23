import {
  INPUT_PROTOCOL_VERSION,
  NETCODE,
  type InputCommandV2,
} from '@rocket-arena/shared';

export interface InputSink {
  send(type: 'input', payload: InputCommandV2): void;
}

/**
 * Every key code this client consumes as gameplay input. Exported so the
 * on-screen control reference can be checked against the real bindings instead
 * of being maintained by hand.
 */
export const GAMEPLAY_CODES = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyQ',
  'KeyE',
  'KeyC',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
]);

/**
 * Which airborne axes this client reads backwards.
 *
 * Inversion is air-only. Driving and steering on the ground are never flipped,
 * because that is not what anyone means by inverting a flight axis, and it needs
 * no grounded flag to arrange: the server consults pitch, roll, and yaw only while
 * a car is off the ground, so flipping those three is air-only by construction.
 *
 * This is a local input-mapping preference and nothing more. It is applied to the
 * command this client builds, so the server keeps one sign convention and never
 * learns that a player flipped an axis; no authoritative state is involved.
 *
 * Flipping the sign rather than swapping which key is bound keeps the two halves
 * of an axis exactly symmetric, so an inverted axis cannot end up stronger in one
 * direction than the other.
 */
export interface AxisInversion {
  /** Air pitch, taken from the W/S keys. */
  readonly pitch: boolean;
  /** Air roll, taken from the A/D keys. */
  readonly roll: boolean;
  /** Air yaw, taken from the Q/E keys. */
  readonly airYaw: boolean;
}

export const NO_AXIS_INVERSION: AxisInversion = Object.freeze({
  pitch: false,
  roll: false,
  airYaw: false,
});

/** Return whether an event target is an editable control rather than gameplay. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;

  const candidate = target as {
    tagName?: string;
    isContentEditable?: boolean;
    closest?: (selector: string) => Element | null;
  };
  const tagName = candidate.tagName?.toUpperCase();
  if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') {
    return true;
  }
  if (candidate.isContentEditable === true) return true;

  return typeof candidate.closest === 'function'
    && candidate.closest('input, textarea, select, [contenteditable="true"]') !== null;
}

/** One frame of controller input, already reduced to what the game needs. */
export interface GamepadSample {
  /** Left stick X, right is positive. */
  readonly stickX: number;
  /** Left stick Y, up is positive. */
  readonly stickY: number;
  /** Right trigger minus left trigger, -1..1. */
  readonly throttle: number;
  readonly jump: boolean;
  readonly boost: boolean;
  readonly powerslide: boolean;
  readonly camera: boolean;
  readonly rollLeft: boolean;
  readonly rollRight: boolean;
}

export const NEUTRAL_GAMEPAD: GamepadSample = Object.freeze({
  stickX: 0, stickY: 0, throttle: 0,
  jump: false, boost: false, powerslide: false, camera: false,
  rollLeft: false, rollRight: false,
});

const STICK_DEADZONE = 0.15;

/** Remove stick drift, rescale the rest to 0..1, and round to cut input chatter. */
export function applyDeadzone(value: number, deadzone = STICK_DEADZONE): number {
  const magnitude = Math.abs(value);
  if (!Number.isFinite(value) || magnitude <= deadzone) return 0;
  const scaled = Math.min(1, (magnitude - deadzone) / (1 - deadzone));
  return Math.sign(value) * Math.round(scaled * 100) / 100;
}

interface PadLike {
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[];
}

/**
 * Standard-mapping layout (Xbox, PlayStation and most iPad-compatible pads):
 * A/Cross jump, B/Circle boost, X/Square powerslide, Y/Triangle ball cam,
 * LB/RB air roll left/right, LT/RT brake/accelerate, left stick steer and pitch.
 */
export function sampleFromGamepad(pad: PadLike): GamepadSample {
  const button = (index: number): boolean => pad.buttons[index]?.pressed === true;
  const trigger = (index: number): number => {
    const b = pad.buttons[index];
    return b ? (b.value > 0 ? b.value : b.pressed ? 1 : 0) : 0;
  };
  return Object.freeze({
    stickX: applyDeadzone(pad.axes[0] ?? 0),
    stickY: applyDeadzone(-(pad.axes[1] ?? 0)),
    throttle: applyDeadzone(trigger(7) - trigger(6), 0.05),
    jump: button(0),
    boost: button(1),
    powerslide: button(2),
    camera: button(3),
    rollLeft: button(4),
    rollRight: button(5),
  });
}

/** Pure keyboard/input transport state used by browser bindings and tests. */
export class InputController {
  private readonly heldCodes = new Set<string>();
  private jumpSequence = 0;
  private cameraToggleSequence = 0;
  private lastRoom: InputSink | null = null;
  private lastPayload = '';
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private forceNextSend = true;
  private axisInversion: AxisInversion = NO_AXIS_INVERSION;
  private gamepad: GamepadSample = NEUTRAL_GAMEPAD;
  private padJumpHeld = false;
  private padCameraHeld = false;

  /**
   * Adopt an axis-inversion preference.
   *
   * Held keys are deliberately not cleared: flipping an axis while a key is down
   * should reverse that axis on the next payload, not drop the press and make the
   * car coast. The next send is forced because the payload changes without any
   * key event, and the transport dedupe would otherwise swallow it.
   */
  setAxisInversion(inversion: Partial<AxisInversion>): void {
    const next = Object.freeze({
      pitch: inversion.pitch === true,
      roll: inversion.roll === true,
      airYaw: inversion.airYaw === true,
    });
    if (next.pitch === this.axisInversion.pitch
      && next.roll === this.axisInversion.roll
      && next.airYaw === this.axisInversion.airYaw) {
      return;
    }
    this.axisInversion = next;
    this.forceNextSend = true;
  }

  getAxisInversion(): AxisInversion {
    return this.axisInversion;
  }

  /**
   * Adopt this frame's controller state. Jump and camera presses are counted
   * on the rising edge, exactly like a keyboard press, so a held button never
   * repeats.
   */
  setGamepad(sample: GamepadSample): void {
    if (sample.jump && !this.padJumpHeld) this.jumpSequence += 1;
    if (sample.camera && !this.padCameraHeld) this.cameraToggleSequence += 1;
    this.padJumpHeld = sample.jump;
    this.padCameraHeld = sample.camera;
    this.gamepad = sample;
  }

  handleKeyDown(code: string, repeat = false): boolean {
    if (!GAMEPLAY_CODES.has(code)) return false;

    const newPhysicalPress = !repeat && !this.heldCodes.has(code);
    if (code === 'Space' && newPhysicalPress) this.jumpSequence += 1;
    if (code === 'KeyC' && newPhysicalPress) this.cameraToggleSequence += 1;
    this.heldCodes.add(code);
    return true;
  }

  handleKeyUp(code: string): boolean {
    if (!GAMEPLAY_CODES.has(code)) return false;
    this.heldCodes.delete(code);
    return true;
  }

  /** Clear held controls without erasing monotonic physical-edge floors. */
  resetHeldKeys(): void {
    this.heldCodes.clear();
    this.gamepad = NEUTRAL_GAMEPAD;
    this.forceNextSend = true;
  }

  /** Forget transport dedupe state so even the same room object is re-synced. */
  detachRoom(): void {
    this.lastRoom = null;
    this.lastPayload = '';
    this.lastSentAt = Number.NEGATIVE_INFINITY;
    this.forceNextSend = true;
  }

  getPayload(): Readonly<InputCommandV2> {
    let throttle = 0;
    let steer = 0;
    let yaw = 0;

    if (this.heldCodes.has('KeyW') || this.heldCodes.has('ArrowUp')) throttle = 1;
    else if (this.heldCodes.has('KeyS') || this.heldCodes.has('ArrowDown')) throttle = -1;

    if (this.heldCodes.has('KeyA') || this.heldCodes.has('ArrowLeft')) steer = 1;
    else if (this.heldCodes.has('KeyD') || this.heldCodes.has('ArrowRight')) steer = -1;

    if (this.heldCodes.has('KeyE')) yaw = 1;
    else if (this.heldCodes.has('KeyQ')) yaw = -1;

    // Keyboard wins when it is pressed; otherwise the controller supplies the
    // axis. W/S double as throttle and pitch, A/D as steer and air roll.
    const pad = this.gamepad;
    let pitchInput = throttle;
    let rollInput = steer;
    if (throttle === 0) {
      throttle = pad.throttle;
      pitchInput = pad.stickY;
    }
    if (steer === 0) {
      steer = pad.stickX === 0 ? 0 : -pad.stickX; // never -0
      rollInput = (pad.rollLeft ? 1 : 0) - (pad.rollRight ? 1 : 0);
    }
    if (yaw === 0) yaw = pad.stickX;

    // Inversion lands on the airborne axes only: the server reads pitch, roll,
    // and yaw solely while a car is off the ground. Zero guards keep a neutral
    // axis at exactly 0 rather than -0.
    const pitch = this.axisInversion.pitch && pitchInput !== 0 ? -pitchInput : pitchInput;
    const roll = this.axisInversion.roll && rollInput !== 0 ? -rollInput : rollInput;
    if (this.axisInversion.airYaw && yaw !== 0) yaw = -yaw;

    return Object.freeze({
      protocolVersion: INPUT_PROTOCOL_VERSION,
      throttle,
      steer,
      pitch,
      yaw,
      roll,
      jumpHeld: this.heldCodes.has('Space') || pad.jump,
      jumpSequence: this.jumpSequence,
      boostHeld: this.heldCodes.has('ShiftLeft') || this.heldCodes.has('ShiftRight') || pad.boost,
      powerslideHeld: this.heldCodes.has('ControlLeft') || this.heldCodes.has('ControlRight') || pad.powerslide,
      cameraToggleSequence: this.cameraToggleSequence,
    });
  }

  /** Send changes, room-initial state, forced neutral state, or a heartbeat. */
  send(room: InputSink, nowMs: number, force = false): boolean {
    if (room !== this.lastRoom) {
      this.lastRoom = room;
      this.lastPayload = '';
      this.lastSentAt = Number.NEGATIVE_INFINITY;
      this.forceNextSend = true;
    }

    const payload = this.getPayload();
    const serialized = JSON.stringify(payload);
    const heartbeatDue = nowMs - this.lastSentAt >= NETCODE.INPUT_HEARTBEAT_MS;
    if (!force && !this.forceNextSend && serialized === this.lastPayload && !heartbeatDue) {
      return false;
    }

    room.send('input', payload);
    this.lastPayload = serialized;
    this.lastSentAt = nowMs;
    this.forceNextSend = false;
    return true;
  }
}
