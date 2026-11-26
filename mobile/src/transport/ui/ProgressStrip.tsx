/** 이송 진행 상황: 단계(번호) + 상태 변경 기록 (Lovable progress.tsx 그대로) */
import { ChevronDown } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Tile, Txt } from '../../ui/kit';
import { color, font } from '../../ui/theme';
import { useEngine } from '../engine';
import { STATUS_LABEL } from '../labels';
import { REASON_LABEL, type TransportStatus } from '../types';

const STEPS: TransportStatus[] = ['requesting', 'moving', 'arrived'];
const hms = (t: number) => {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export function ProgressStrip() {
  const e = useEngine();
  const [open, setOpen] = useState(false);
  if (!e.status) return null;
  const idx = e.status === 'fallback' || e.status === 'phone_check' ? 0 : STEPS.indexOf(e.status);
  return (
    <Tile style={{ marginBottom: 16, padding: 14 }}>
      <Pressable
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityLabel={`진행 기록 ${e.history.length}개 ${open ? '닫기' : '보기'}`}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}
      >
        <View style={{ flex: 1, flexDirection: 'row' }}>
          {STEPS.map((st, i) => (
            <View key={st} style={{ flex: 1, gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <View
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 10,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor:
                      i === idx ? color.accent : i < idx ? color.primary : color.surface2,
                  }}
                >
                  <Txt
                    style={{
                      fontFamily: font.extrabold,
                      fontSize: 10,
                      color: i <= idx ? color.accentText : color.muted,
                    }}
                  >
                    {i + 1}
                  </Txt>
                </View>
                {i < STEPS.length - 1 ? (
                  <View
                    style={{
                      flex: 1,
                      height: 3,
                      marginHorizontal: 4,
                      borderRadius: 2,
                      backgroundColor: i < idx ? 'rgba(30,33,36,0.6)' : color.border,
                    }}
                  />
                ) : null}
              </View>
              <Txt
                style={{
                  fontSize: 11,
                  fontFamily: i === idx ? font.extrabold : font.regular,
                  color: i === idx ? color.foreground : color.muted,
                }}
              >
                {i === 0 && idx === 0 ? STATUS_LABEL[e.status!] : STATUS_LABEL[st]}
              </Txt>
            </View>
          ))}
        </View>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 2,
            paddingHorizontal: 10,
            paddingVertical: 4,
            borderRadius: 999,
            backgroundColor: color.surface2,
          }}
        >
          <Txt style={{ fontFamily: font.bold, fontSize: 12, color: color.muted }}>
            기록 {e.history.length}
          </Txt>
          <ChevronDown
            size={14}
            color={color.muted}
            style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}
          />
        </View>
      </Pressable>
      {open ? (
        <View
          style={{
            marginTop: 12,
            paddingTop: 12,
            borderTopWidth: 1,
            borderTopColor: color.border,
            gap: 10,
          }}
        >
          {[...e.history].reverse().map((h, i) => (
            <View key={i} style={{ flexDirection: 'row', gap: 10 }}>
              <View
                style={{
                  width: 7,
                  height: 7,
                  marginTop: 6,
                  borderRadius: 4,
                  backgroundColor: i === 0 ? color.accent : color.borderStrong,
                }}
              />
              <Txt style={{ width: 56, fontSize: 11, color: color.muted, paddingTop: 2 }}>
                {hms(h.at)}
              </Txt>
              <View style={{ flex: 1 }}>
                <Txt style={{ fontFamily: font.bold, fontSize: 14 }}>{h.label}</Txt>
                <Txt style={{ fontSize: 12, color: color.muted }}>
                  {h.from ? STATUS_LABEL[h.from] : '시작'} → {STATUS_LABEL[h.to]}
                  {h.reason ? ` · ${REASON_LABEL[h.reason] ?? h.reason}` : ''}
                </Txt>
              </View>
            </View>
          ))}
        </View>
      ) : null}
    </Tile>
  );
}
