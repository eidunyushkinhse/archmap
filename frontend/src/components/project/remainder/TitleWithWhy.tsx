// Заголовок вопроса со знаком «?» сразу после текста: в подсказке «почему возник вопрос» и
// «Если не отвечать, то …». Последнее слово и знак в одной обёртке без переноса: знак не
// уезжает на строку один. Подсказка — fixed-слой (InfoPopover), прокрутка тела окна её не
// режет. Один вид у вопросов окон ввоза (RemainderBlock) и «Собрать с компонентов»
// (CollectFactsModal).
import InfoPopover from "../../../ui/InfoPopover";
import "./remainder.css";

export default function TitleWithWhy({ title, why, ifLeft }: { title: string; why: string; ifLeft: string | null }) {
  const cut = title.lastIndexOf(" ") + 1;
  return (
    <>
      {title.slice(0, cut)}
      <span className="rq-q-end">
        {title.slice(cut)}
        <InfoPopover label="Почему возник вопрос" width={380}>
          <p>{why}</p>
          {ifLeft !== null && <p>{ifLeft}</p>}
        </InfoPopover>
      </span>
    </>
  );
}
