/**
 * Web Audio API micro-haptic sound synthesizer
 * Zero external audio assets required. Generates ultra-crisp agency-grade UI micro-clicks.
 */

class AudioHapticsEngine {
  private ctx: AudioContext | null = null;

  private getContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  /**
   * Crisp tactile click for copy actions
   */
  private cleanup(osc: OscillatorNode, gain: GainNode, filter?: BiquadFilterNode) {
    const t = (this.ctx?.currentTime ?? 0) + 0.3;
    setTimeout(() => {
      try { osc.disconnect(); } catch {}
      try { gain.disconnect(); } catch {}
      try { filter?.disconnect(); } catch {}
    }, 350);
    void t;
  }

  public playCopyPunch(): void {
    try {
      const ctx = this.getContext();
      if (!ctx) return;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1760, ctx.currentTime + 0.04);

      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.05);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start();
      osc.stop(ctx.currentTime + 0.05);
      osc.onended = () => this.cleanup(osc, gain);
    } catch {
      // Audio autoplay policy catch
    }
  }

  /**
   * Deep mechanical pulse for stage transitions
   */
  public playTransitionSubtle(): void {
    try {
      const ctx = this.getContext();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(140, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(45, ctx.currentTime + 0.18);
      gain.gain.setValueAtTime(0.06, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.2);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.2);
      osc.onended = () => this.cleanup(osc, gain);
    } catch {}
  }

  /**
   * Ultra-short glass tick for hovers
   */
  public playHoverTick(): void {
    try {
      const ctx = this.getContext();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1200, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(800, ctx.currentTime + 0.015);
      gain.gain.setValueAtTime(0.015, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.015);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.02);
      osc.onended = () => this.cleanup(osc, gain);
    } catch {}
  }

  /**
   * Clean dual-tone pop for Tab selection
   */
  public playTabSelect(): void {
    try {
      const ctx = this.getContext();
      if (!ctx) return;
      
      const playTone = (freq: number, delay: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, ctx.currentTime + delay);
        gain.gain.setValueAtTime(0.05, ctx.currentTime + delay);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + 0.08);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + delay);
        osc.stop(ctx.currentTime + delay + 0.1);
        osc.onended = () => this.cleanup(osc, gain);
      };
      
      playTone(440, 0);
      playTone(554.37, 0.03); // C#4
    } catch {}
  }

  /**
   * Snappy click for sorting filters
   */
  public playSortChange(): void {
    try {
      const ctx = this.getContext();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(600, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(200, ctx.currentTime + 0.05);
      gain.gain.setValueAtTime(0.04, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.06);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.07);
      osc.onended = () => this.cleanup(osc, gain);
    } catch {}
  }

  /**
   * Ascending mechanical zip for Refresh
   */
  public playRefresh(): void {
    try {
      const ctx = this.getContext();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      
      // Pass through a lowpass filter to make it sound mechanical but not harsh
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(400, ctx.currentTime);
      filter.frequency.linearRampToValueAtTime(2000, ctx.currentTime + 0.15);

      osc.frequency.setValueAtTime(100, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(400, ctx.currentTime + 0.15);
      
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.03, ctx.currentTime + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.2);
      
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
      osc.onended = () => this.cleanup(osc, gain, filter);
    } catch {}
  }

  /**
   * Descending thud for clearing/deleting
   */
  public playClearCache(): void {
    try {
      const ctx = this.getContext();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(800, ctx.currentTime);
      filter.frequency.exponentialRampToValueAtTime(100, ctx.currentTime + 0.15);

      osc.frequency.setValueAtTime(150, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.15);
      
      gain.gain.setValueAtTime(0.04, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.2);
      
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
      osc.onended = () => this.cleanup(osc, gain, filter);
    } catch {}
  }

  /**
   * High-tech error pulse
   */
  public playErrorPulse(): void {
    try {
      const ctx = this.getContext();
      if (!ctx) return;
      
      const playPulse = (delay: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 1000;
        
        osc.frequency.setValueAtTime(150, ctx.currentTime + delay);
        osc.frequency.exponentialRampToValueAtTime(100, ctx.currentTime + delay + 0.1);
        
        gain.gain.setValueAtTime(0.05, ctx.currentTime + delay);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + 0.1);
        
        osc.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);
        
        osc.start(ctx.currentTime + delay);
        osc.stop(ctx.currentTime + delay + 0.15);
        osc.onended = () => this.cleanup(osc, gain, filter);
      };
      
      playPulse(0);
      playPulse(0.12);
    } catch {}
  }
}

export const AudioHaptics = new AudioHapticsEngine();
