import type { GeodeticView } from '../core/Geo';

export interface TourStop {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly view: GeodeticView;
  readonly durationSeconds?: number;
  readonly pauseSeconds?: number;
}

export interface TourNavigator {
  flyTo(view: GeodeticView, duration?: number, signal?: AbortSignal): Promise<void> | void;
}

export interface TourChangeDetail {
  readonly running: boolean;
  readonly index: number;
  readonly stop?: TourStop;
}

export class GuidedTour extends EventTarget {
  private abort: AbortController | null = null;
  private index = -1;

  constructor(private readonly navigator: TourNavigator, readonly stops: readonly TourStop[]) { super(); }

  get running(): boolean { return this.abort !== null; }

  async start(startIndex = 0): Promise<void> {
    this.stop();
    if (this.stops.length === 0) return;
    const abort = new AbortController();
    this.abort = abort;
    try {
      for (let index = Math.max(0, startIndex); index < this.stops.length; index += 1) {
        if (abort.signal.aborted) break;
        this.index = index;
        const stop = this.stops[index];
        this.dispatch(stop);
        await this.navigator.flyTo(stop.view, stop.durationSeconds ?? 2.4, abort.signal);
        await delay((stop.pauseSeconds ?? 2.2) * 1_000, abort.signal);
      }
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    } finally {
      if (this.abort === abort) {
        this.abort = null;
        this.dispatch();
      }
    }
  }

  stop(): void {
    this.abort?.abort();
    this.abort = null;
    this.dispatch();
  }

  private dispatch(stop?: TourStop): void {
    this.dispatchEvent(new CustomEvent<TourChangeDetail>('change', {
      detail: { running: this.running, index: this.index, stop },
    }));
  }
}

export const DENMARK_TOUR: readonly TourStop[] = [
  { id: 'denmark', title: 'Denmark', description: 'The kingdom between the North Sea and the Baltic.', view: { longitude: 10.2, latitude: 56.1, height: 800_000, pitch: -Math.PI / 2 } },
  { id: 'skagen', title: 'Skagen', description: 'Denmark’s northern tip, where two seas meet.', view: { longitude: 10.5839, latitude: 57.7209, height: 18_000, pitch: -1.05 } },
  { id: 'aarhus', title: 'Aarhus', description: 'The largest city in Jutland.', view: { longitude: 10.2039, latitude: 56.1629, height: 9_000, pitch: -1.0 } },
  { id: 'billund', title: 'Billund', description: 'The birthplace of LEGO.', view: { longitude: 9.1518, latitude: 55.7284, height: 5_000, pitch: -0.95 } },
  { id: 'odense', title: 'Odense', description: 'Hans Christian Andersen’s home city.', view: { longitude: 10.4024, latitude: 55.4038, height: 8_000, pitch: -1.0 } },
  { id: 'copenhagen', title: 'Copenhagen', description: 'The capital viewed down to its streets and buildings.', view: { longitude: 12.5683, latitude: 55.6761, height: 2_500, pitch: -0.9 } },
  { id: 'bornholm', title: 'Bornholm', description: 'The Baltic island east of the rest of Denmark.', view: { longitude: 14.9167, latitude: 55.1667, height: 30_000, pitch: -1.1 } },
];

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Tour cancelled', 'AbortError'));
    }, { once: true });
  });
}
