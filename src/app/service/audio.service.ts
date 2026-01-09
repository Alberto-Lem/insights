import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class AudioService {
  private audio?: HTMLAudioElement;

  bind(audio: HTMLAudioElement){
    this.audio = audio;
  }

  async start(): Promise<boolean>{
    if (!this.audio) return false;
    this.audio.volume = 0.65;
    this.audio.muted = false;

    try{
      await this.audio.play();
      return true;
    }catch{
      return false;
    }
  }

  stop(){
    try{
      this.audio?.pause();
      if (this.audio) this.audio.currentTime = 0;
    }catch{}
  }

  installAutoKick(onKick: () => void){
    const kick = () => {
      onKick();
      window.removeEventListener('pointerdown', kick);
      window.removeEventListener('keydown', kick);
    };
    window.addEventListener('pointerdown', kick, { passive: true });
    window.addEventListener('keydown', kick);
  }
}
