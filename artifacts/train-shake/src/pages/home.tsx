import { Link } from 'wouter';
import { Activity, Map } from 'lucide-react';

export default function Home() {
  return (
    <div className="min-h-[100dvh] w-full flex flex-col bg-background p-6">
      <div className="flex-1 flex flex-col justify-center items-center max-w-md mx-auto w-full gap-8">
        
        <div className="text-center mb-4">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-xl bg-primary/10 text-primary mb-6">
            <Activity className="w-8 h-8" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground mb-2">
            火車搖晃程度紀錄系統
          </h1>
          <p className="text-muted-foreground text-sm leading-relaxed">
            這是一個嚴謹的資料收集工具，用於記錄火車行駛間的搖晃程度與 GPS 位置，供工程分析參考使用。
          </p>
        </div>

        <div className="flex flex-col w-full gap-4">
          <Link 
            href="/record" 
            className="group relative flex w-full items-center gap-4 rounded-lg border border-primary/20 bg-card p-6 shadow-sm transition-all hover:border-primary/40 hover:shadow-md active:scale-[0.98]"
            data-testid="link-new-record"
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary group-hover:bg-primary group-hover:text-primary-foreground transition-colors">
              <Activity className="h-6 w-6" />
            </div>
            <div className="flex flex-col flex-1 text-left">
              <span className="text-lg font-semibold text-foreground">開始新紀錄</span>
              <span className="text-sm text-muted-foreground">開啟感測器並記錄當前行程</span>
            </div>
          </Link>

          <Link 
            href="/map" 
            className="group relative flex w-full items-center gap-4 rounded-lg border border-border bg-card p-6 shadow-sm transition-all hover:border-primary/40 hover:shadow-md active:scale-[0.98]"
            data-testid="link-history-map"
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary text-secondary-foreground group-hover:bg-primary group-hover:text-primary-foreground transition-colors">
              <Map className="h-6 w-6" />
            </div>
            <div className="flex flex-col flex-1 text-left">
              <span className="text-lg font-semibold text-foreground">檢視歷史紀錄</span>
              <span className="text-sm text-muted-foreground">在地圖上瀏覽過往搖晃熱力圖</span>
            </div>
          </Link>
        </div>

      </div>
    </div>
  );
}