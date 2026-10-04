// ECS adapter for elate-particles: an effect that follows its entity.
// Applied in Redshift as gameClient/engine/entityManagement/components/particle-effect.ts.
//
//   entity.addComponent("ParticleEffectComponent", {
//       world: particleWorld,
//       effect: "thruster",
//       offset: new THREE.Vector3(0, 0, -1.2),   // engine nozzle, entity space
//       params: { throttle: 0 },
//   });
//   (entity.getComponent("ParticleEffectComponent") as ParticleEffectComponent).setParam("throttle", 1);

import * as THREE from "three/webgpu";
import type { EffectDoc } from "elate-particles";
import type { ParticleEffect, ParticleWorld } from "elate-particles/three";

import { Entity, Component } from "../entity.ts";

interface ParticleEffectParams {
    world: ParticleWorld;
    /** Registered effect id, or a document (registered on first use). */
    effect: string | EffectDoc;
    /** Position in entity space (nozzle, muzzle, hardpoint). */
    offset?: THREE.Vector3;
    /** Extra rotation in entity space, applied after the entity's rotation. */
    rotationOffset?: THREE.Quaternion;
    scale?: number;
    params?: Record<string, number>;
    /** Track the entity every frame (default true). False: spawn once at the entity and stay put. */
    follow?: boolean;
    /** Read inherit-velocity from a component with a `velocity` Vector3 (e.g. "ShipEngineComponent"). */
    velocityFrom?: string;
    /** Called every lateStep after the transform update, e.g. to drive parameters from other components. */
    drive?: (effect: ParticleEffect, entity: Entity) => void;
    /** Kill the entity once the effect finishes (one-shot effects on their own entity). Default false. */
    killEntityWhenDone?: boolean;
    /**
     * On dispose, stop spawning and let live particles finish in place
     * (default true: a destroyed ship's trail fades instead of vanishing).
     */
    lingerOnDispose?: boolean;
}

class ParticleEffectComponent extends Component {
    #handle_: ParticleEffect | null = null;
    #offset_: THREE.Vector3 | null = null;
    #rotationOffset_: THREE.Quaternion | null = null;
    #follow_ = true;
    #velocityFrom_: string | null = null;
    #drive_: ParticleEffectParams["drive"] | null = null;
    #killEntityWhenDone_ = false;
    #lingerOnDispose_ = true;

    // scratch, reused every frame
    #pos_ = new THREE.Vector3();
    #quat_ = new THREE.Quaternion();
    #tmp_ = new THREE.Vector3();

    constructor(entity: Entity) {
        super(entity);
    }

    onInit(_context: unknown, params: ParticleEffectParams): void {
        this.#offset_ = params.offset ?? null;
        this.#rotationOffset_ = params.rotationOffset ?? null;
        this.#follow_ = params.follow ?? true;
        this.#velocityFrom_ = params.velocityFrom ?? null;
        this.#drive_ = params.drive ?? null;
        this.#killEntityWhenDone_ = params.killEntityWhenDone ?? false;
        this.#lingerOnDispose_ = params.lingerOnDispose ?? true;

        this.#computeTransform_();
        this.#handle_ = params.world.spawn(params.effect, {
            position: this.#pos_,
            rotation: this.#quat_,
            scale: params.scale,
            params: params.params,
            autoRelease: false,
        });
    }

    #computeTransform_(): void {
        this.#quat_.copy(this.rotation);
        this.#pos_.copy(this.position);
        if (this.#offset_) this.#pos_.add(this.#tmp_.copy(this.#offset_).applyQuaternion(this.#quat_));
        if (this.#rotationOffset_) this.#quat_.multiply(this.#rotationOffset_);
    }

    // lateStep: entity transforms are final for the frame; ParticleWorld.update runs after.
    onLateStep(_timeElapsed: number, _totalTime: number): void {
        const handle = this.#handle_;
        if (!handle) return;

        if (this.#follow_) {
            this.#computeTransform_();
            handle.setTransform(this.#pos_, this.#quat_);
        }
        if (this.#velocityFrom_) {
            const v = (this.entity.getComponent(this.#velocityFrom_) as { velocity?: THREE.Vector3 } | undefined)?.velocity;
            if (v) handle.setVelocity(v);
        }
        this.#drive_?.(handle, this.entity);
        if (this.#killEntityWhenDone_ && !handle.alive) {
            this.entity.isDead = true;
        }
    }

    onDispose(): void {
        const handle = this.#handle_;
        this.#handle_ = null;
        if (!handle) return;
        if (this.#lingerOnDispose_ && handle.alive) {
            handle.autoRelease = true;
            handle.stop();
        } else {
            handle.release();
        }
    }

    setParam(name: string, value: number): void {
        this.#handle_?.setParam(name, value);
    }

    /** Restart from the beginning. */
    play(): void {
        this.#handle_?.teleport().play();
    }

    /** Stop spawning; live particles finish. */
    stop(): void {
        this.#handle_?.stop();
    }

    /** Jumped (warp, respawn): don't smear spawns along the jump. */
    teleport(): void {
        this.#computeTransform_();
        this.#handle_?.setTransform(this.#pos_, this.#quat_).teleport();
    }

    get effect(): ParticleEffect | null {
        return this.#handle_;
    }
}

export { ParticleEffectComponent };
export type { ParticleEffectParams };
